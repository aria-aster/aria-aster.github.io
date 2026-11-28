// Ekasane ジェネレーター (alpha0.00.1)
// 詳細設計：ekasane-generator-lld.md
import { Ekasane } from "./ekasane-lib.js";
import { EkasaneRenderer } from "./renderer.js";
import { Unzip, UnzipInflate, UnzipPassThrough } from "./fflate.js";

// ---------------------------------------------------------------- 定数
const LIMITS = {
  ZIP_TOTAL_MAX: 200 * 1024 * 1024,
  ZIP_ENTRY_MAX: 64 * 1024 * 1024,
  ZIP_RATIO_MAX: 100,
  ZIP_RATIO_MIN_SIZE: 1 * 1024 * 1024,
};
const REGISTER_TIMEOUT_MS = 30000;
const HEADER_MAX_BYTES = 1 * 1024 * 1024;
const SOFTWARE_NAME = "Ekasane Generator alpha0.00.1";

// ---------------------------------------------------------------- 状態
const G = {
  mode: "file",
  packageId: null,
  manifest: null,
  entries: null,
  currentFolder: null,
  ekasane: null,
  renderer: null,
  inputSpecs: [],
  userImages: new Map(),   // object ID -> Blob（現テンプレート分）
  values: new Map(),       // object ID -> 最後に setValue が成功した値
  seenTemplateIds: new Map(),
  warnings: [],
  screenState: "no-package",
};

// ---------------------------------------------------------------- DOM
const $ = (id) => document.getElementById(id);
const els = {
  menuBtn: $("menuBtn"), menuPanel: $("menuPanel"),
  menuOpen: $("menuOpen"), menuClearCache: $("menuClearCache"), menuDeleteSaves: $("menuDeleteSaves"),
  templateBtn: $("templateBtn"), templatePanel: $("templatePanel"),
  subBtn: $("subBtn"), subPanel: $("subPanel"),
  authorRow: $("authorRow"), authorName: $("authorName"),
  saveName: $("saveName"), saveBtn: $("saveBtn"), saveList: $("saveList"),
  errorBand: $("errorBand"),
  noTemplateNote: $("noTemplateNote"), inputFields: $("inputFields"),
  previewImg: $("previewImg"), previewPlaceholder: $("previewPlaceholder"),
  previewBtn: $("previewBtn"), outputBtn: $("outputBtn"),
  warningArea: $("warningArea"),
  packageFileInput: $("packageFileInput"),
  loadStatus: $("loadStatus"), loadStatusText: $("loadStatusText"),
  dialogBackdrop: $("dialogBackdrop"), dialogTitle: $("dialogTitle"), dialogBody: $("dialogBody"),
  dialogOk: $("dialogOk"), dialogCancel: $("dialogCancel"),
};

// ---------------------------------------------------------------- 小物
function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject({ code: "TIMEOUT", message: `timeout ${ms}ms` }), ms));
  return Promise.race([promise, timeout]);
}

function errMessage(e) {
  if (e == null) return "";
  if (typeof e === "string") return e;
  return e.message || e.code || String(e);
}

function dataDir() {
  return (G.manifest && G.manifest.data) || "data";
}

// ---------------------------------------------------------------- 警告
function addWarning(w) {
  G.warnings.push(w);
}
function setWarnings(list) {
  G.warnings = list.slice();
  renderWarnings();
}
function renderWarnings() {
  const area = els.warningArea;
  area.textContent = "";
  if (G.warnings.length === 0) return;
  const h = document.createElement("h3");
  h.textContent = `警告（${G.warnings.length}件）`;
  const ul = document.createElement("ul");
  for (const w of G.warnings) {
    const li = document.createElement("li");
    li.textContent = (w.objectId ? `${w.objectId}: ` : "") + w.message + (w.code ? ` [${w.code}]` : "");
    ul.appendChild(li);
  }
  area.append(h, ul);
}

// ---------------------------------------------------------------- エラー表示
// 読み込み中ステータス（画面左上・indeterminate バー＋段階テキスト）
function showLoadStatus(text) {
  if (els.loadStatusText) els.loadStatusText.textContent = text || "";
  if (els.loadStatus) els.loadStatus.hidden = false;
}
function setLoadStatus(text) {
  if (els.loadStatus && !els.loadStatus.hidden && els.loadStatusText) els.loadStatusText.textContent = text || "";
}
function hideLoadStatus() {
  if (els.loadStatus) els.loadStatus.hidden = true;
}

function showError(code, message) {
  G.screenState = "error";
  els.errorBand.hidden = false;
  els.errorBand.textContent = `エラー [${code}] ${message}`;
  updateControls();
}
function clearError() {
  els.errorBand.hidden = true;
  els.errorBand.textContent = "";
}

// ---------------------------------------------------------------- ダイアログ
let dialogResolve = null;
function showDialog({ title, messages = [], okLabel = "OK", cancelLabel = null }) {
  els.dialogTitle.textContent = title;
  const body = els.dialogBody;
  body.textContent = "";
  if (messages.length > 0) {
    const ul = document.createElement("ul");
    for (const m of messages) {
      const li = document.createElement("li");
      li.textContent = m;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  els.dialogOk.textContent = okLabel;
  els.dialogCancel.hidden = cancelLabel === null;
  if (cancelLabel !== null) els.dialogCancel.textContent = cancelLabel;
  els.dialogBackdrop.hidden = false;
  return new Promise((resolve) => { dialogResolve = resolve; });
}
function closeDialog(result) {
  els.dialogBackdrop.hidden = true;
  if (dialogResolve) { dialogResolve(result); dialogResolve = null; }
}
els.dialogOk.addEventListener("click", () => closeDialog(true));
els.dialogCancel.addEventListener("click", () => closeDialog(false));

// ---------------------------------------------------------------- 画面の有効・無効
function updateControls() {
  const ready = G.screenState === "ready";
  els.previewBtn.disabled = !ready;
  els.outputBtn.disabled = !ready;
  els.saveBtn.disabled = !ready;
  const hasPackage = !!G.packageId;
  els.menuDeleteSaves.classList.toggle("disabled", !hasPackage);
  const list = G.manifest && Array.isArray(G.manifest.list) ? G.manifest.list : null;
  els.templateBtn.disabled = !list || list.length === 0;
}

// ---------------------------------------------------------------- zip の関門と展開
// セントラルディレクトリを読む（宣言値の判定用）
function readCentralDirectory(buf) {
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // EOCD レコードを末尾から探す
  let eocd = -1;
  const minPos = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw { code: "MANIFEST_NOT_FOUND", message: "zip の終端レコードが見つかりません" };
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const entries = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const compressed = view.getUint32(pos + 20, true);
    const uncompressed = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const name = dec.decode(u8.subarray(pos + 46, pos + 46 + nameLen));
    entries.push({ name, compressed, uncompressed });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function checkZipLimits(cdEntries) {
  let total = 0;
  for (const e of cdEntries) {
    if (e.uncompressed === 0xffffffff || e.compressed === 0xffffffff) continue; // ZIP64 は実バイト数判定に任せる
    total += e.uncompressed;
    if (e.uncompressed > LIMITS.ZIP_ENTRY_MAX) return false;
    if (e.uncompressed >= LIMITS.ZIP_RATIO_MIN_SIZE) {
      if (e.compressed === 0 || e.uncompressed / e.compressed > LIMITS.ZIP_RATIO_MAX) return false;
    }
  }
  return total <= LIMITS.ZIP_TOTAL_MAX;
}

// .ekn を開き、Map<path, Blob> を返す。関門を通らなければ例外（code 付き）
async function openEkn(file) {
  const buf = await file.arrayBuffer();
  const cd = readCentralDirectory(buf);
  if (!checkZipLimits(cd)) {
    throw { code: "ZIP_LIMIT_EXCEEDED", message: "zip の上限（合計／1エントリ／圧縮比）を超えています" };
  }
  const files = new Map();
  let totalActual = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const uz = new Unzip((zipFile) => {
      const name = zipFile.name.replace(/\\/g, "/").replace(/^\/+/, "");
      if (name.endsWith("/") || name === "") return; // フォルダエントリは読み飛ばす
      if (name.split("/").includes("..")) return;    // 危険なパスは読み飛ばす
      const chunks = [];
      let size = 0;
      zipFile.ondata = (err, chunk, final) => {
        if (settled) return;
        if (err) { fail({ code: "ZIP_LIMIT_EXCEEDED", message: `解凍に失敗しました: ${name}` }); return; }
        if (chunk) {
          size += chunk.byteLength;
          totalActual += chunk.byteLength;
          if (size > LIMITS.ZIP_ENTRY_MAX || totalActual > LIMITS.ZIP_TOTAL_MAX) {
            try { zipFile.terminate(); } catch { /* noop */ }
            fail({ code: "ZIP_LIMIT_EXCEEDED", message: "解凍後の実サイズが上限を超えました" });
            return;
          }
          chunks.push(chunk);
        }
        if (final) files.set(name, new Blob(chunks));
      };
      zipFile.start();
    });
    uz.register(UnzipInflate);
    uz.register(UnzipPassThrough);
    uz.onerror = (code, message) => fail({ code: "ZIP_LIMIT_EXCEEDED", message: `zip を読めませんでした: ${message || code}` });
    const u8 = new Uint8Array(buf);
    const SLICE = 1024 * 1024;
    try {
      for (let off = 0; off < u8.byteLength; off += SLICE) {
        const end = Math.min(u8.byteLength, off + SLICE);
        uz.push(u8.subarray(off, end), end >= u8.byteLength);
      }
    } catch (e) {
      fail(e);
      return;
    }
    // Unzip は push(final) で全ファイルの ondata(final) が同期的に流れる前提だが、
    // 念のため完了をポーリングで待つ
    const timer = setInterval(() => {
      if (settled) { clearInterval(timer); return; }
      // 全エントリが files に揃ったら完了とみなす
      const expected = cd.filter((e) => !e.name.endsWith("/")).length;
      if (files.size >= expected) { settled = true; clearInterval(timer); resolve(); }
    }, 50);
    setTimeout(() => { if (!settled) { settled = true; clearInterval(timer); resolve(); } }, 10000);
  });
  return files;
}

// ---------------------------------------------------------------- entries（2経路の隠蔽）
function makeFileEntries(files) {
  return {
    async read(path) {
      const blob = files.get(path);
      if (!blob) throw { code: "TEMPLATE_NOT_FOUND", message: `ファイルがありません: ${path}` };
      return blob;
    },
    async readStream() { return null; }, // .ekn 経路ではストリーム判定はしない
    has(path) { return files.has(path); },
  };
}

function makeServerEntries() {
  return {
    async read(path) {
      const res = await fetch(path);
      if (!res.ok) throw { code: "TEMPLATE_NOT_FOUND", message: `ファイルが取れません: ${path}` };
      return res.blob();
    },
    async readStream(path) {
      const res = await fetch(path);
      if (!res.ok) return null;
      return res.body;
    },
    async has(path) {
      try { const res = await fetch(path, { method: "HEAD" }); return res.ok; }
      catch { return false; }
    },
  };
}

// ---------------------------------------------------------------- パッケージを開く
async function setPackage(manifest, entries) {
  if (!manifest.id) {
    showError("UUID_MISSING", "ekasane.manifest に id（UUID）がありません");
    return;
  }
  G.packageId = manifest.id;
  G.manifest = manifest;
  G.entries = entries;
  G.seenTemplateIds = new Map();
  clearError();
  const res = G.renderer.initPackage(manifest.id);
  if (res && res.success === false) {
    showError((res.error && res.error.code) || "INVALID_DATA", errMessage(res.error) || "initPackage に失敗しました");
    return;
  }
  buildTemplatePanel();
  updateControls();
  const folder = selectInitialTemplate(manifest);
  if (folder === null) return; // エラー表示済み
  await loadTemplate(folder);
}

async function openPackageFromFile(file) {
  G.screenState = "loading";
  showLoadStatus("パッケージを展開しています…");
  try {
    const files = await openEkn(file);
    const manifestBlob = files.get("ekasane.manifest");
    if (!manifestBlob) {
      showError("MANIFEST_NOT_FOUND", "ekasane.manifest が見つかりません");
      return;
    }
    let manifest;
    try {
      manifest = JSON.parse(await manifestBlob.text());
    } catch {
      showError("MANIFEST_INVALID", "ekasane.manifest の JSON が壊れています");
      return;
    }
    G.mode = "file";
    await setPackage(manifest, makeFileEntries(files));
  } catch (e) {
    showError(e.code || "MANIFEST_NOT_FOUND", errMessage(e));
  } finally {
    hideLoadStatus();
  }
}

async function openPackageFromServer(manifestText) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    showError("MANIFEST_INVALID", "ekasane.manifest の JSON が壊れています");
    return;
  }
  G.mode = "auto";
  showLoadStatus("パッケージを読み込んでいます…");
  try {
    await setPackage(manifest, makeServerEntries());
  } finally {
    hideLoadStatus();
  }
}

function selectInitialTemplate(manifest) {
  const list = Array.isArray(manifest.list) ? manifest.list : null;
  if (!list || list.length === 0) return "";
  if (manifest.default != null) {
    const hit = list.find((e) => e.folder === manifest.default);
    if (!hit) {
      showError("DEFAULT_TEMPLATE_NOT_FOUND", `default のテンプレート（${manifest.default}）が list にありません`);
      return null;
    }
    return hit.folder;
  }
  return list[0].folder;
}

function templateNameOf(folder) {
  const list = G.manifest && Array.isArray(G.manifest.list) ? G.manifest.list : [];
  const hit = list.find((e) => e.folder === folder);
  if (hit) return hit.name;
  return (G.ekasane && G.ekasane.common && G.ekasane.common.title) || folder || "テンプレート";
}

// ---------------------------------------------------------------- テンプレート読み込みと準備
async function loadTemplate(folder) {
  G.screenState = "loading";
  showLoadStatus("テンプレートを読み込んでいます…");
  updateControls();
  setWarnings([]);
  clearError();
  try {
    const path = folder === "" ? "ekasane.json" : `${folder}/ekasane.json`;
    const text = await (await G.entries.read(path)).text();
    let ekasane;
    try {
      ekasane = Ekasane.parse(text);
    } catch (e) {
      showError("PARSE_FAILED", `ekasane.json を解釈できませんでした: ${errMessage(e)}`);
      return;
    }
    G.ekasane = ekasane;
    G.currentFolder = folder;
    G.userImages = new Map();
    G.values = new Map();

    const cid = ekasane.common && ekasane.common.id;
    if (cid) {
      // 重複の警告は「別のフォルダのテンプレートが同じ common.id を持っている」ときだけ。
      // 同じフォルダを開き直すのは通常の操作なので無言で通す
      const seenFolder = G.seenTemplateIds.get(cid);
      if (seenFolder !== undefined && seenFolder !== folder) {
        addWarning({ scope: "template", code: "DUPLICATE_TEMPLATE_ID", message: `common.id「${cid}」は、このパッケージで既に開いたテンプレートと重複しています` });
      } else {
        G.seenTemplateIds.set(cid, folder);
      }
    }

    await prepareTemplate();
    setLoadStatus("入力欄を準備しています…");
    collectInputSpecs();
    applyInitialValues();
    buildInputFields();
    updateTemplateButton();
    updateAuthorRow();
    const validation = runValidation();
    setWarnings(G.warnings.concat(validation));
    await refreshSaveList();
    G.screenState = "ready";
    updateControls();
  } catch (e) {
    showError(e.code || "TEMPLATE_NOT_FOUND", errMessage(e));
  } finally {
    hideLoadStatus();
  }
}

async function prepareTemplate() {
  const ekasane = G.ekasane;
  const common = ekasane.common;
  const initRes = G.renderer.initImage(common.id, common.width, common.height);
  if (initRes && initRes.success === false) {
    throw { code: (initRes.error && initRes.error.code) || "INVALID_DATA", message: errMessage(initRes.error) || "initImage に失敗しました" };
  }
  // 同梱フォント
  setLoadStatus("フォントを読み込んでいます…");
  for (const fileName of (G.manifest && G.manifest.font) || []) {
    try {
      const data = await G.entries.read(`${dataDir()}/font/${fileName}`);
      const res = await withTimeout(G.renderer.importFontFile(data), REGISTER_TIMEOUT_MS);
      if (!res || res.success === false) {
        addWarning({ scope: "template", message: `フォントファイルを読み込めませんでした: ${fileName}${res && res.error ? `（${errMessage(res.error)}）` : ""}` });
      } else if (res.warning) {
        addWarning({ scope: "template", message: String(res.warning) });
      }
    } catch (e) {
      addWarning({ scope: "template", code: e.code, message: `フォントの準備に失敗しました: ${fileName}（${errMessage(e)}）` });
    }
  }
  // フォント定義の登録
  for (const [id, def] of ekasane.font || []) {
    try {
      const res = await G.renderer.registerFont(id, def);
      if (res && res.success === false) {
        addWarning({ scope: "template", objectId: id, message: `フォント定義を登録できませんでした: ${errMessage(res.error)}` });
      } else if (res && res.warning) {
        addWarning({ scope: "template", objectId: id, message: String(res.warning) });
      }
    } catch (e) {
      addWarning({ scope: "template", objectId: id, message: `フォント定義の登録に失敗しました: ${errMessage(e)}` });
    }
  }
  // material の登録
  setLoadStatus("画像データを取り込んでいます…");
  for (const [id, def] of ekasane.material || []) {
    await registerBundledMaterial(id, def);
  }
}

async function registerBundledMaterial(id, def) {
  const isImage = !def || def["material-type"] == null || def["material-type"] === "image";
  const fileName = (def && def.path) || id;
  const path = `${dataDir()}/image/${fileName}`;
  try {
    let blob = null;
    if (isImage) {
      // 巨大画像ルールの例外（trimming がある material は、切り抜き後が範囲内なら元寸法2倍まで許容）のため、
      // material 定義の trimming を checkImage の options で渡す。判定の中身はライブラリ側
      const checkOptions = def && def.trimming ? { trimming: def.trimming } : undefined;
      const stream = await G.entries.readStream(path).catch(() => null);
      if (stream) {
        blob = await fetchImageChecked(path, stream, checkOptions);
      } else {
        blob = await G.entries.read(path);
        const head = await blob.slice(0, HEADER_MAX_BYTES).arrayBuffer();
        const check = G.ekasane.checkImage(new Uint8Array(head), checkOptions);
        if (check.status === "error") {
          addWarning({ scope: "template", objectId: id, code: check.code, message: check.message || `画像の関門を通りませんでした: ${fileName}` });
          return;
        }
        if (check.status === "pending") {
          addWarning({ scope: "template", objectId: id, code: "IMAGE_INVALID_HEADER", message: `画像のヘッダを判定できませんでした: ${fileName}` });
          return;
        }
      }
    } else {
      blob = await G.entries.read(path);
    }
    const res = await withTimeout(G.renderer.registerMaterial(id, blob), REGISTER_TIMEOUT_MS);
    if (!res || res.success === false) {
      addWarning({ scope: "template", objectId: id, message: `素材を登録できませんでした: ${fileName}${res && res.error ? `（${errMessage(res.error)}）` : ""}` });
    } else if (res.warning) {
      addWarning({ scope: "template", objectId: id, message: String(res.warning) });
    }
  } catch (e) {
    addWarning({ scope: "template", objectId: id, code: e.code, message: `素材の準備に失敗しました: ${fileName}（${errMessage(e)}）` });
  }
}

// サーバー経路：1回の fetch で、判定しながら画像を取る
async function fetchImageChecked(path, stream, checkOptions) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
    if (total > 0) {
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      const check = G.ekasane.checkImage(buf.subarray(0, Math.min(total, HEADER_MAX_BYTES)), checkOptions);
      if (check.status === "error") {
        try { await reader.cancel(); } catch { /* noop */ }
        throw { code: check.code, message: check.message || `画像の関門を通りませんでした: ${path}` };
      }
      if (check.status === "pending" && total >= HEADER_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* noop */ }
        throw { code: "IMAGE_HEADER_TOO_DEEP", message: `ヘッダの判定に必要な範囲を超えました: ${path}` };
      }
      if (check.status === "ok" && done) return new Blob(chunks);
    }
    if (done) {
      // 最後まで読んでも ok にならなかった場合は失敗として扱う
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      const check = G.ekasane.checkImage(buf, checkOptions);
      if (check.status === "ok") return new Blob(chunks);
      throw { code: check.code || "IMAGE_INVALID_HEADER", message: check.message || `画像のヘッダを判定できませんでした: ${path}` };
    }
  }
}

// ---------------------------------------------------------------- バリデーション（枠）
function runValidation() {
  if (!G.ekasane || typeof G.ekasane.validate !== "function") return [];
  try {
    const res = G.ekasane.validate();
    if (!res || !Array.isArray(res.issues)) return [];
    const out = [];
    for (const issue of res.issues) {
      if (issue.result === false || issue.warning) {
        out.push({
          scope: issue.kind || "template",
          objectId: issue.id,
          code: issue.code,
          message: issue.message || issue.warning || "バリデーションで問題が見つかりました",
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 入力 UI
function collectInputSpecs() {
  const specs = [];
  let order = 0;
  for (const [objectId, def] of G.ekasane.object || []) {
    const myOrder = order++;
    if (!def || def.type === "shape") continue;
    const v = def.value;
    if (!v || typeof v !== "object" || !Array.isArray(v.function)) continue;
    const fn = v.function;
    if (fn[0] !== "input") continue;
    const params = fn.slice(1);
    const spec = {
      objectId,
      type: def.type,
      label: def.label || objectId,
      z: typeof def.z === "number" ? def.z : 0,
      order: myOrder,
      candidates: null,
      localFile: false,
      def,
    };
    if (def.type === "image") {
      if (params.length === 0 || typeof params[0] !== "boolean") {
        addWarning({ scope: "object", objectId, message: "image の input にローカル選択フラグがありません（テンプレートの書き方エラー）。入力欄は作りません" });
        continue;
      }
      spec.localFile = params[0];
      spec.candidates = params.slice(1);
      if (!spec.localFile && spec.candidates.length === 0) {
        addWarning({ scope: "object", objectId, message: "image の input に候補が無く、ローカル選択もできない指定です。入力欄は作りません" });
        continue;
      }
    } else if (params.length > 0) {
      spec.candidates = params;
    }
    specs.push(spec);
  }
  // 並び順は common.input-order で切り替える（ascending＝z 昇順。それ以外・省略時は descending＝z 降順）
  const inputOrder = String((G.ekasane.common && G.ekasane.common["input-order"]) || "").toLowerCase();
  if (inputOrder === "ascending") specs.sort((a, b) => (a.z - b.z) || (a.order - b.order));
  else specs.sort((a, b) => (b.z - a.z) || (a.order - b.order));
  G.inputSpecs = specs;
}

function initialValueOf(spec) {
  const def = spec.def;
  if (def["default-value"] !== undefined) return def["default-value"];
  if (spec.type === "image") return def["material-id"];
  if (spec.candidates && spec.candidates.length > 0) return spec.candidates[0];
  if (spec.type === "numeric") return typeof def.min === "number" ? def.min : 0;
  return "";
}

// setValue の共通入口。成功したら G.values に控える
function applyValue(objectId, value) {
  const res = G.ekasane.setValue(objectId, value);
  if (res && res.result) {
    G.values.set(objectId, value);
    if (res.warning) addWarning({ scope: "object", objectId, message: String(res.warning) });
    return { ok: true, res };
  }
  return { ok: false, res };
}

function applyInitialValues() {
  for (const spec of G.inputSpecs) {
    const v = initialValueOf(spec);
    if (v === undefined) continue;
    const { ok, res } = applyValue(spec.objectId, v);
    if (!ok) {
      addWarning({ scope: "object", objectId: spec.objectId, code: res && res.code, message: `初期値を入れられませんでした: ${res ? errMessage(res) : ""}` });
    }
  }
  renderWarnings();
}

const fieldControls = new Map(); // objectId -> { control, errorEl, refresh() }

function buildInputFields() {
  const wrap = els.inputFields;
  wrap.textContent = "";
  fieldControls.clear();
  els.noTemplateNote.hidden = G.inputSpecs.length > 0;
  for (const spec of G.inputSpecs) {
    wrap.appendChild(buildField(spec));
  }
}

function fieldShell(spec) {
  const div = document.createElement("div");
  div.className = "field";
  const label = document.createElement("label");
  label.textContent = spec.label;
  const err = document.createElement("div");
  err.className = "ferr";
  div.append(label);
  return { div, err };
}

function setFieldError(objectId, message) {
  const fc = fieldControls.get(objectId);
  if (fc) fc.errorEl.textContent = message || "";
}

function buildField(spec) {
  const { div, err } = fieldShell(spec);
  const def = spec.def;
  const current = G.values.get(spec.objectId);

  const onSetFail = (res) => {
    setFieldError(spec.objectId, res ? errMessage(res) : "値を設定できませんでした");
    const fc = fieldControls.get(spec.objectId);
    if (fc && fc.refresh) fc.refresh();
  };
  const onSetOk = () => setFieldError(spec.objectId, "");

  if (spec.type === "text" && !spec.candidates) {
    div.append(buildRichTextField(spec, err, onSetOk));
  } else if (spec.type === "text" || spec.type === "numeric") {
    if (spec.candidates) {
      const control = document.createElement("select");
      for (const c of spec.candidates) {
        const opt = document.createElement("option");
        opt.value = String(c);
        opt.textContent = String(c);
        control.appendChild(opt);
      }
      control.value = current != null ? String(current) : String(spec.candidates[0]);
      control.addEventListener("change", () => {
        const v = spec.type === "numeric" ? Number(control.value) : control.value;
        const r = applyValue(spec.objectId, v);
        if (r.ok) onSetOk(); else onSetFail(r.res);
      });
      div.append(control);
      fieldControls.set(spec.objectId, { control, errorEl: err, refresh() { const v = G.values.get(spec.objectId); if (v != null) control.value = String(v); } });
    } else {
      // numeric 自由入力
      const control = document.createElement("input");
      control.type = "number";
      if (typeof def.min === "number") control.min = String(def.min);
      if (typeof def.max === "number") control.max = String(def.max);
      if (typeof def["decimal-places"] === "number") control.step = String(Math.pow(10, -def["decimal-places"]));
      control.value = current != null ? String(current) : "";
      const row = document.createElement("div");
      row.className = "inline";
      row.append(control);
      if (typeof def.min === "number" && typeof def.max === "number") {
        const range = document.createElement("span");
        range.className = "range";
        range.textContent = `${def.min}〜${def.max}`;
        row.append(range);
      }
      control.addEventListener("change", () => {
        if (control.value === "") { setFieldError(spec.objectId, "数値を入力してください"); return; }
        const r = applyValue(spec.objectId, Number(control.value));
        if (r.ok) onSetOk(); else onSetFail(r.res);
      });
      div.append(row);
      fieldControls.set(spec.objectId, { control, errorEl: err, refresh() { const v = G.values.get(spec.objectId); control.value = v != null ? String(v) : ""; } });
    }
  } else if (spec.type === "image") {
    const row = document.createElement("div");
    row.className = "inline";
    let fileInput = null;
    if (spec.localFile) {
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.id = spec.objectId;
      fileInput.hidden = true;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sbtn";
      btn.textContent = "ファイルを選ぶ";
      btn.addEventListener("click", () => fileInput.click());
      row.append(btn, fileInput);
    }
    const thumbs = new Map();
    for (const cand of spec.candidates || []) {
      const img = document.createElement("img");
      img.className = "cand";
      img.alt = String(cand);
      img.title = String(cand);
      img.addEventListener("click", () => {
        G.userImages.delete(spec.objectId);
        const r = applyValue(spec.objectId, cand);
        if (r.ok) { onSetOk(); markSelected(); } else onSetFail(r.res);
      });
      thumbs.set(cand, img);
      row.append(img);
      // サムネイルは同梱ファイルの Blob URL で出す
      const mdef = G.ekasane.material && G.ekasane.material.get(cand);
      const fileName = (mdef && mdef.path) || cand;
      G.entries.read(`${dataDir()}/image/${fileName}`).then((blob) => {
        img.src = URL.createObjectURL(blob);
      }).catch(() => { img.alt = String(cand); });
    }
    const markSelected = () => {
      const v = G.values.get(spec.objectId);
      for (const [cand, img] of thumbs) img.classList.toggle("selected", v === cand);
    };
    markSelected();
    div.append(row);
    fieldControls.set(spec.objectId, { control: fileInput, errorEl: err, refresh: markSelected });
    if (fileInput) {
      // ライブラリの bindImageInput でファイル選択を接続する
      G.ekasane.bindImageInput(fileInput, (objectId, file) => { void onUserImageSelected(objectId, file); });
    }
  }

  div.append(err);
  return div;
}

async function onUserImageSelected(objectId, file) {
  if (!file) return;
  G.userImages.set(objectId, file);
  const runtimeId = G.ekasane.issueRuntimeId(objectId);
  try {
    const res = await withTimeout(G.renderer.registerMaterial(runtimeId, file), REGISTER_TIMEOUT_MS);
    if (!res || res.success === false) {
      addWarning({ scope: "object", objectId, message: `画像を登録できませんでした${res && res.error ? `（${errMessage(res.error)}）` : ""}` });
      renderWarnings();
      return;
    }
  } catch (e) {
    addWarning({ scope: "object", objectId, code: e.code, message: `画像の登録に失敗しました（${errMessage(e)}）` });
    renderWarnings();
    return;
  }
  const r = applyValue(objectId, runtimeId);
  if (!r.ok) {
    setFieldError(objectId, r.res ? errMessage(r.res) : "値を設定できませんでした");
  } else {
    setFieldError(objectId, "");
    const fc = fieldControls.get(objectId);
    if (fc && fc.refresh) fc.refresh();
  }
  renderWarnings();
}

// ---------------------------------------------------------------- プレビューと最終出力
function outputMime() {
  const t = G.ekasane && G.ekasane.common && G.ekasane.common.output && G.ekasane.common.output.type;
  return t || "image/png";
}

let previewUrl = null;
async function doPreview() {
  if (!G.ekasane) return;
  const validation = runValidation();
  const res = G.renderer.render(G.ekasane);
  if (!res || res.success === false) {
    showError((res && res.error && res.error.code) || "INVALID_DATA", (res && errMessage(res.error)) || "描画できませんでした");
    return;
  }
  const warnings = validation.concat((res.warnings || []).map((w) => ({ scope: "object", objectId: w.id, code: w.code, message: w.message })));
  setWarnings(warnings);
  const img = await G.renderer.getImage(outputMime());
  if (!img || img.success === false || !img.data) {
    showError((img && img.error && img.error.code) || "ENCODE_FAILED", (img && errMessage(img.error)) || "画像を取り出せませんでした");
    return;
  }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(img.data);
  els.previewImg.src = previewUrl;
  els.previewImg.hidden = false;
  els.previewPlaceholder.hidden = true;
}

async function doFinalOutput() {
  if (!G.ekasane) return;
  const validation = runValidation();
  const res = G.renderer.render(G.ekasane);
  if (!res || res.success === false) {
    showError((res && res.error && res.error.code) || "INVALID_DATA", (res && errMessage(res.error)) || "描画できませんでした");
    return;
  }
  const warnings = validation.concat((res.warnings || []).map((w) => ({ scope: "object", objectId: w.id, code: w.code, message: w.message })));
  setWarnings(warnings);
  if (warnings.length > 0) {
    const go = await showDialog({
      title: "警告があります",
      messages: warnings.map((w) => (w.objectId ? `${w.objectId}: ` : "") + w.message),
      okLabel: "出力する",
      cancelLabel: "やめる",
    });
    if (!go) return;
  }
  const img = await G.renderer.getImage(outputMime());
  if (!img || img.success === false || !img.data) {
    showError((img && img.error && img.error.code) || "ENCODE_FAILED", (img && errMessage(img.error)) || "画像を取り出せませんでした");
    return;
  }
  const output = (G.ekasane.common && G.ekasane.common.output) || {};
  let blob = img.data;
  const embedded = await embedMetadata(blob, output);
  blob = embedded.blob;
  if (embedded.warning) {
    addWarning({ scope: "system", message: embedded.warning });
    renderWarnings();
  }
  downloadBlob(blob, buildOutputFileName(output, blob.type || img.data.type));
}

function buildOutputFileName(output, actualType) {
  let name = (output && output.name) || "ekasane_output.png";
  if (!/\.[a-z0-9]+$/i.test(name)) {
    const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[actualType] || ".png";
    name += ext;
  }
  return name;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------- メタデータ埋め込み
function collectMetadataItems(output) {
  const items = [];
  if (!output) return items;
  for (const key of ["title", "author", "description", "comment", "copyright"]) {
    const v = output[key];
    if (typeof v === "string" && v !== "") items.push([key, v]);
  }
  if (output["creation-time"] === true) items.push(["creation-time", new Date().toISOString()]);
  if (output.software === true) items.push(["software", SOFTWARE_NAME]);
  return items;
}

async function embedMetadata(blob, output) {
  const items = collectMetadataItems(output);
  if (items.length === 0) return { blob };
  const type = blob.type || "";
  const buf = new Uint8Array(await blob.arrayBuffer());
  try {
    if (type === "image/png") {
      return { blob: new Blob([embedPngText(buf, items)], { type }) };
    }
    if (type === "image/jpeg") {
      return { blob: new Blob([embedJpegXmp(buf, items)], { type }) };
    }
    if (type === "image/webp") {
      return { blob: new Blob([embedWebpXmp(buf, items)], { type }) };
    }
  } catch (e) {
    return { blob, warning: `メタデータを埋められませんでした（${errMessage(e)}）` };
  }
  return { blob, warning: `この形式（${type || "不明"}）ではメタデータを埋めていません` };
}

// --- PNG: tEXt チャンクを IHDR の直後へ挿入
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function embedPngText(buf, items) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error("PNG ではありません");
  const keyMap = {
    title: "Title", author: "Author", description: "Description",
    comment: "Comment", copyright: "Copyright",
    "creation-time": "Creation Time", software: "Software",
  };
  const enc = new TextEncoder();
  const chunks = items.map(([key, value]) => {
    const kw = enc.encode(keyMap[key] || key);
    const tx = enc.encode(value);
    const data = new Uint8Array(kw.length + 1 + tx.length);
    data.set(kw, 0);
    data.set(tx, kw.length + 1);
    return pngChunk("tEXt", data);
  });
  // IHDR チャンクの終わりを探す（署名8 + 長さ4 + 型4 + データ + CRC4）
  const ihdrLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(8);
  const insertAt = 8 + 12 + ihdrLen;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(buf.length + total);
  out.set(buf.subarray(0, insertAt), 0);
  let off = insertAt;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  out.set(buf.subarray(insertAt), off);
  return out;
}

// --- XMP パケット（JPEG / WebP 共通）
function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function buildXmpPacket(items) {
  const get = (k) => { const hit = items.find(([key]) => key === k); return hit ? hit[1] : null; };
  const alt = (v) => `<rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(v)}</rdf:li></rdf:Alt>`;
  let inner = "";
  const title = get("title"); if (title) inner += `<dc:title>${alt(title)}</dc:title>`;
  const author = get("author"); if (author) inner += `<dc:creator><rdf:Seq><rdf:li>${xmlEscape(author)}</rdf:li></rdf:Seq></dc:creator>`;
  const desc = get("description"); if (desc) inner += `<dc:description>${alt(desc)}</dc:description>`;
  const comment = get("comment"); if (comment) inner += `<exif:UserComment>${alt(comment)}</exif:UserComment>`;
  const rights = get("copyright"); if (rights) inner += `<dc:rights>${alt(rights)}</dc:rights>`;
  const created = get("creation-time"); if (created) inner += `<xmp:CreateDate>${xmlEscape(created)}</xmp:CreateDate>`;
  const software = get("software"); if (software) inner += `<xmp:CreatorTool>${xmlEscape(software)}</xmp:CreatorTool>`;
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">`
    + inner
    + `</rdf:Description></rdf:RDF></x:xmpmeta>`;
}

// --- JPEG: APP1 セグメントへ XMP を入れる
function embedJpegXmp(buf, items) {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("JPEG ではありません");
  const enc = new TextEncoder();
  const ns = enc.encode("http://ns.adobe.com/xap/1.0/\0");
  const xml = enc.encode(buildXmpPacket(items));
  const segLen = 2 + ns.length + xml.length;
  if (segLen > 0xffff) throw new Error("XMP が大きすぎます");
  const seg = new Uint8Array(2 + segLen);
  seg[0] = 0xff; seg[1] = 0xe1;
  new DataView(seg.buffer).setUint16(2, segLen);
  seg.set(ns, 4);
  seg.set(xml, 4 + ns.length);
  const out = new Uint8Array(buf.length + seg.length);
  out.set(buf.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(buf.subarray(2), 2 + seg.length);
  return out;
}

// --- WebP: XMP チャンク方式（VP8X が無ければ追加する）
function readU24le(b, off) { return b[off] | (b[off + 1] << 8) | (b[off + 2] << 16); }
function writeU24le(b, off, v) { b[off] = v & 0xff; b[off + 1] = (v >> 8) & 0xff; b[off + 2] = (v >> 16) & 0xff; }
function webpCanvasSize(buf, chunks) {
  for (const c of chunks) {
    const d = buf.subarray(c.dataOff, c.dataOff + c.size);
    if (c.type === "VP8 " && d.length >= 10) {
      const w = (d[6] | (d[7] << 8)) & 0x3fff;
      const h = (d[8] | (d[9] << 8)) & 0x3fff;
      return { width: w, height: h };
    }
    if (c.type === "VP8L" && d.length >= 5) {
      const b0 = d[1], b1 = d[2], b2 = d[3], b3 = d[4];
      const w = (b0 | ((b1 & 0x3f) << 8)) + 1;
      const h = (((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10))) + 1;
      return { width: w, height: h };
    }
    if (c.type === "VP8X" && d.length >= 10) {
      return { width: readU24le(d, 4) + 1, height: readU24le(d, 7) + 1 };
    }
  }
  return null;
}
function embedWebpXmp(buf, items) {
  const fourcc = (b, off) => String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
  if (buf.length < 12 || fourcc(buf, 0) !== "RIFF" || fourcc(buf, 8) !== "WEBP") throw new Error("WebP ではありません");
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const size = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(pos + 4, true);
    chunks.push({ type: fourcc(buf, pos), off: pos, dataOff: pos + 8, size });
    pos += 8 + size + (size % 2);
  }
  const xml = new TextEncoder().encode(buildXmpPacket(items));
  const xmpChunk = new Uint8Array(8 + xml.length + (xml.length % 2));
  xmpChunk.set(new TextEncoder().encode("XMP "), 0);
  new DataView(xmpChunk.buffer).setUint32(4, xml.length, true);
  xmpChunk.set(xml, 8);

  const vp8x = chunks.find((c) => c.type === "VP8X");
  let head; // VP8X までの新しい先頭部分
  let rest; // それより後ろ（既存チャンク列）
  if (vp8x) {
    // 既存 VP8X の XMP フラグを立てて使い回す
    const out = new Uint8Array(buf.length + xmpChunk.length);
    out.set(buf, 0);
    out[20] |= 0x04; // VP8X データ先頭のフラグバイト（12 + 8 = 20）
    out.set(xmpChunk, buf.length);
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    return out;
  }
  const size = webpCanvasSize(buf, chunks);
  if (!size) throw new Error("WebP の寸法が分かりません");
  const vp8xChunk = new Uint8Array(18);
  vp8xChunk.set(new TextEncoder().encode("VP8X"), 0);
  new DataView(vp8xChunk.buffer).setUint32(4, 10, true);
  vp8xChunk[8] = 0x04; // XMP フラグ
  writeU24le(vp8xChunk, 12, Math.max(0, size.width - 1));
  writeU24le(vp8xChunk, 15, Math.max(0, size.height - 1));
  head = vp8xChunk;
  rest = buf.subarray(12);
  const out = new Uint8Array(12 + head.length + rest.length + xmpChunk.length);
  out.set(buf.subarray(0, 12), 0);
  out.set(head, 12);
  out.set(rest, 12 + head.length);
  out.set(xmpChunk, 12 + head.length + rest.length);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

// ---------------------------------------------------------------- 入力データの保存・呼び出し（IndexedDB）
function templateKey() {
  const cid = G.ekasane && G.ekasane.common ? G.ekasane.common.id : "";
  return `${G.currentFolder || ""}\n${cid}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`ekasane-${G.packageId}`, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore("saves", { keyPath: ["templateKey", "name"] });
      store.createIndex("byTemplate", "templateKey", { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSave(name) {
  const db = await openDb();
  try {
    return await idbRequest(db.transaction("saves", "readonly").objectStore("saves").get([templateKey(), name]));
  } finally { db.close(); }
}

async function listSaves() {
  if (!G.packageId || !G.ekasane) return [];
  const db = await openDb();
  try {
    const store = db.transaction("saves", "readonly").objectStore("saves");
    const rows = await idbRequest(store.index("byTemplate").getAll(templateKey()));
    rows.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    return rows;
  } finally { db.close(); }
}

async function refreshSaveList() {
  const wrap = els.saveList;
  wrap.textContent = "";
  let rows = [];
  try { rows = await listSaves(); } catch { rows = []; }
  if (rows.length === 0) {
    const div = document.createElement("div");
    div.className = "save-empty";
    div.textContent = "保存データはありません";
    wrap.appendChild(div);
    return;
  }
  for (const row of rows) {
    const div = document.createElement("div");
    div.className = "data-row";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = row.name;
    const dt = document.createElement("span");
    dt.className = "dt";
    dt.textContent = new Date(row.savedAt).toLocaleString("ja-JP");
    const sp = document.createElement("div");
    sp.className = "spacer";
    const loadBtn = document.createElement("button");
    loadBtn.className = "sbtn";
    loadBtn.textContent = "呼び出す";
    loadBtn.addEventListener("click", () => { void loadInputData(row.name); });
    const delBtn = document.createElement("button");
    delBtn.className = "sbtn";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => { void deleteSave(row.name); });
    div.append(nm, dt, sp, loadBtn, delBtn);
    wrap.appendChild(div);
  }
}

async function saveInputData() {
  const name = els.saveName.value.trim();
  if (!name) {
    await showDialog({ title: "保存名がありません", messages: ["保存名を入力してください"], okLabel: "OK" });
    return;
  }
  const existing = await getSave(name).catch(() => null);
  if (existing) {
    const go = await showDialog({
      title: "上書きの確認",
      messages: [`「${name}」は既に保存されています。上書きしますか？`],
      okLabel: "上書きする",
      cancelLabel: "やめる",
    });
    if (!go) return;
  }
  const values = {};
  const images = {};
  for (const spec of G.inputSpecs) {
    const v = G.values.get(spec.objectId);
    if (spec.type === "image") {
      const blob = G.userImages.get(spec.objectId);
      if (blob && v === G.ekasane.issueRuntimeId(spec.objectId)) {
        images[spec.objectId] = blob;
        continue;
      }
    }
    if (v !== undefined) values[spec.objectId] = v;
  }
  const record = {
    templateKey: templateKey(),
    name,
    savedAt: new Date().toISOString(),
    templateTitle: templateNameOf(G.currentFolder),
    values,
    images,
  };
  const db = await openDb();
  try {
    await idbRequest(db.transaction("saves", "readwrite").objectStore("saves").put(record));
  } finally { db.close(); }
  els.saveName.value = "";
  await refreshSaveList();
}

async function loadInputData(name) {
  const record = await getSave(name).catch(() => null);
  if (!record) return;
  // まず初期値に戻す
  G.userImages = new Map();
  G.values = new Map();
  applyInitialValues();
  const specIds = new Set(G.inputSpecs.map((s) => s.objectId));
  let skipped = 0;
  for (const key of Object.keys(record.values || {})) if (!specIds.has(key)) skipped++;
  for (const key of Object.keys(record.images || {})) if (!specIds.has(key)) skipped++;
  for (const [objectId, value] of Object.entries(record.values || {})) {
    if (!specIds.has(objectId)) continue;
    const r = applyValue(objectId, value);
    if (!r.ok) addWarning({ scope: "object", objectId, code: r.res && r.res.code, message: `呼び出し時に値を入れられませんでした: ${r.res ? errMessage(r.res) : ""}` });
  }
  for (const [objectId, blob] of Object.entries(record.images || {})) {
    if (!specIds.has(objectId)) continue;
    await onUserImageSelected(objectId, blob);
  }
  buildInputFields();
  renderWarnings();
  if (skipped > 0) {
    await showDialog({
      title: "呼び出しのお知らせ",
      messages: [`現在のテンプレートに無い項目が ${skipped} 件ありました。その分は捨てました`],
      okLabel: "OK",
    });
  }
}

async function deleteSave(name) {
  const db = await openDb();
  try {
    await idbRequest(db.transaction("saves", "readwrite").objectStore("saves").delete([templateKey(), name]));
  } finally { db.close(); }
  await refreshSaveList();
}

async function deleteAllSaves() {
  if (!G.packageId) return;
  const go = await showDialog({
    title: "保存データの削除",
    messages: ["このパッケージの保存データを全部消します。元に戻せません"],
    okLabel: "全部消す",
    cancelLabel: "やめる",
  });
  if (!go) return;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(`ekasane-${G.packageId}`);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  await refreshSaveList();
}

// ---------------------------------------------------------------- キャッシュ削除
async function clearCache() {
  if (!G.renderer) return;
  const res = G.renderer.clearRegistData();
  if (!res || res.success === false) {
    await showDialog({
      title: "キャッシュの削除",
      messages: [`キャッシュを消せませんでした${res && res.error ? `（${errMessage(res.error)}）` : ""}`],
      okLabel: "OK",
    });
    return;
  }
  if (!G.packageId || !G.ekasane) return;
  // 開いているパッケージとテンプレートで、登録をやり直す
  G.renderer.initPackage(G.packageId);
  setWarnings([]);
  await prepareTemplate();
  for (const [objectId, blob] of G.userImages) {
    const runtimeId = G.ekasane.issueRuntimeId(objectId);
    try {
      await withTimeout(G.renderer.registerMaterial(runtimeId, blob), REGISTER_TIMEOUT_MS);
    } catch (e) {
      addWarning({ scope: "object", objectId, code: e.code, message: `持ち込み画像の再登録に失敗しました（${errMessage(e)}）` });
    }
  }
  renderWarnings();
}

// ---------------------------------------------------------------- 画面まわり
function closePanels() {
  els.menuPanel.hidden = true;
  els.templatePanel.hidden = true;
  els.subPanel.hidden = true;
}
function togglePanel(panel) {
  const willOpen = panel.hidden;
  closePanels();
  panel.hidden = !willOpen;
}
els.menuBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(els.menuPanel); });
els.templateBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(els.templatePanel); });
els.subBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(els.subPanel); });
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dropdown") && !e.target.closest(".hbtn")) closePanels();
});

function buildTemplatePanel() {
  const panel = els.templatePanel;
  panel.textContent = "";
  const list = G.manifest && Array.isArray(G.manifest.list) ? G.manifest.list : [];
  for (const entry of list) {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = entry.name;
    div.addEventListener("click", () => {
      closePanels();
      if (entry.folder !== G.currentFolder) void loadTemplate(entry.folder);
    });
    panel.appendChild(div);
  }
}

function updateTemplateButton() {
  els.templateBtn.textContent = `テンプレート：${templateNameOf(G.currentFolder)} ▾`;
  const list = G.manifest && Array.isArray(G.manifest.list) ? G.manifest.list : [];
  for (const [i, child] of [...els.templatePanel.children].entries()) {
    child.classList.toggle("current", list[i] && list[i].folder === G.currentFolder);
  }
  updateControls();
}

function updateAuthorRow() {
  const author = G.ekasane && G.ekasane.common ? G.ekasane.common.author : null;
  if (author) {
    els.authorName.textContent = author;
    els.authorRow.hidden = false;
  } else {
    els.authorRow.hidden = true;
  }
}

els.menuOpen.addEventListener("click", () => {
  closePanels();
  els.packageFileInput.value = "";
  els.packageFileInput.click();
});
els.packageFileInput.addEventListener("change", () => {
  const file = els.packageFileInput.files && els.packageFileInput.files[0];
  if (file) void openPackageFromFile(file);
});
els.menuClearCache.addEventListener("click", () => { closePanels(); void clearCache(); });
els.menuDeleteSaves.addEventListener("click", () => {
  if (!G.packageId) return;
  closePanels();
  void deleteAllSaves();
});
els.saveBtn.addEventListener("click", () => { void saveInputData(); });
els.previewBtn.addEventListener("click", () => { void doPreview(); });
els.outputBtn.addEventListener("click", () => { void doFinalOutput(); });

// ---------------------------------------------------------------- 起動
async function initGenerator() {
  G.renderer = new EkasaneRenderer();
  updateControls();
  try {
    const res = await fetch("ekasane.manifest", { cache: "no-store" });
    if (res.ok) {
      const text = await res.text();
      const manifest = JSON.parse(text);
      if (manifest && manifest.id) {
        await openPackageFromServer(text);
        return;
      }
    }
  } catch { /* 取れなければファイルモード */ }
  G.mode = "file";
  G.screenState = "no-package";
  updateControls();
}

void initGenerator();

// ---------------------------------------------------------------- リッチテキストエディタ（text 自由入力用）
// 内部モデルはラン配列。編集エリア（contenteditable）の span に属性を写し、
// 取り出すときにランへ戻す。改行はエリア内では "\n" の文字として保持し、
// ラン変換時に「直前のランの newline: true」へ直す。
const RUN_ATTR_KEYS = ["weight", "italic", "color", "size", "family", "set"];

function pickRunAttrs(run) {
  const a = {};
  for (const k of RUN_ATTR_KEYS) if (run[k] !== undefined) a[k] = run[k];
  return a;
}

function runsFromValue(v) {
  if (Array.isArray(v)) return v.map((r) => ({ ...r }));
  if (typeof v === "string" && v !== "") return [{ text: v }];
  return [];
}

function normalizeRuns(runs) {
  const out = [];
  for (const raw of runs) {
    const run = { text: raw.text || "", ...pickRunAttrs(raw) };
    if (raw.newline) run.newline = true;
    const last = out[out.length - 1];
    if (last && !last.newline && JSON.stringify(pickRunAttrs(last)) === JSON.stringify(pickRunAttrs(run))) {
      last.text += run.text;
      if (run.newline) last.newline = true;
    } else {
      out.push(run);
    }
  }
  while (out.length > 1) {
    const last = out[out.length - 1];
    if (last.text === "" && !last.newline) out.pop(); else break;
  }
  return out;
}

function renderRuns(area, runs) {
  area.textContent = "";
  for (const run of runs) {
    const span = document.createElement("span");
    span.dataset.attrs = JSON.stringify(pickRunAttrs(run));
    // フォントセット（set）があれば、その定義の見た目を下地にする（表示は近似）
    if (run.set && G.ekasane && G.ekasane.font) {
      const defId = String(run.set).replace(/^ekasane\.font\./, "");
      const fdef = G.ekasane.font.get(defId);
      if (fdef) {
        if (fdef.weight) span.style.fontWeight = String(fdef.weight);
        if (fdef.size) span.style.fontSize = `${Math.max(11, Math.round(fdef.size * 0.4))}px`;
        if (Array.isArray(fdef.family) && fdef.family.length > 0) span.style.fontFamily = fdef.family.join(",");
      }
    }
    if (run.weight) span.style.fontWeight = String(run.weight);
    if (run.italic) span.style.fontStyle = "italic";
    if (run.color) span.style.color = run.color;
    if (run.size) span.style.fontSize = `${Math.max(11, Math.round(run.size * 0.4))}px`;
    span.textContent = (run.text || "") + (run.newline ? "\n" : "");
    area.appendChild(span);
  }
}

function extractRuns(area) {
  const runs = [];
  const markNewline = () => {
    const last = runs[runs.length - 1];
    if (last) last.newline = true;
  };
  const pushText = (text, attrs) => {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (part !== "") runs.push({ text: part, ...attrs });
      if (i < parts.length - 1) markNewline();
    });
  };
  const walk = (node, attrs) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        pushText(child.textContent, attrs);
      } else if (child.nodeType === 1) {
        if (child.tagName === "BR") { markNewline(); continue; }
        let a = attrs;
        try { a = { ...attrs, ...JSON.parse(child.dataset.attrs || "{}") }; } catch { /* データ属性が無ければ継承 */ }
        if ((child.tagName === "DIV" || child.tagName === "P") && runs.length > 0) markNewline();
        walk(child, a);
      }
    }
  };
  walk(area, {});
  return normalizeRuns(runs);
}

function buildRichTextField(spec, err, onSetOk) {
  const def = spec.def;
  const wrap = document.createElement("div");
  wrap.className = "rich";

  // ツールバー：フォントセット（ekasane.font の定義）の選択リスト。
  // 選んだセットはテキスト本文全体のランに set として適用する（2026-11-21 本人の整理）
  const toolbar = document.createElement("div");
  toolbar.className = "rich-toolbar";
  const fsLabel = document.createElement("span");
  fsLabel.className = "rich-label";
  fsLabel.textContent = "フォントセット";
  const fsSel = document.createElement("select");
  fsSel.className = "fontset";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "（なし）";
  fsSel.appendChild(noneOpt);
  const mixedOpt = document.createElement("option");
  mixedOpt.value = "__mixed__";
  mixedOpt.textContent = "（混在）";
  mixedOpt.disabled = true;
  mixedOpt.hidden = true;
  fsSel.appendChild(mixedOpt);
  for (const [fid] of (G.ekasane.font || [])) {
    const opt = document.createElement("option");
    opt.value = fid;
    opt.textContent = fid;
    fsSel.appendChild(opt);
  }
  toolbar.append(fsLabel, fsSel);

  const area = document.createElement("div");
  area.className = "rich-area" + (def.multiline ? " multiline" : "");
  area.contentEditable = "true";
  area.spellcheck = false;

  let commitTimer = null;

  // 現在のラン全体の set の状態（揃っていればその id、無ければ ""、バラバラなら "__mixed__"）
  const currentFontSet = (runs) => {
    let seen = null;
    for (const run of runs) {
      const v = run.set ? String(run.set).replace(/^ekasane\.font\./, "") : "";
      if (seen === null) seen = v;
      else if (seen !== v) return "__mixed__";
    }
    return seen === null ? "" : seen;
  };
  const syncFontSetSelect = () => {
    const v = currentFontSet(extractRuns(area));
    mixedOpt.hidden = v !== "__mixed__";
    fsSel.value = v;
  };

  const commit = () => {
    const runs = extractRuns(area);
    const plainLen = runs.reduce((s, r) => s + (r.text ? r.text.length : 0), 0);
    const maxLen = typeof def["max-length"] === "number" ? def["max-length"] : 0;
    if (maxLen > 0 && plainLen > maxLen) {
      setFieldError(spec.objectId, `最大 ${maxLen} 文字です（現在 ${plainLen} 文字）`);
      return;
    }
    const hasContent = runs.some((r) => r.text !== "" || r.newline);
    const r = applyValue(spec.objectId, hasContent ? runs : "");
    if (r.ok) {
      onSetOk();
      if (r.res && r.res.warning) renderWarnings();
    } else {
      setFieldError(spec.objectId, r.res ? errMessage(r.res) : "値を設定できませんでした");
    }
  };

  fsSel.addEventListener("change", () => {
    const v = fsSel.value;
    if (v === "__mixed__") return;
    const runs = extractRuns(area);
    for (const run of runs) {
      if (v === "") delete run.set;
      else run.set = `ekasane.font.${v}`;
    }
    renderRuns(area, normalizeRuns(runs));
    syncFontSetSelect();
    commit();
  });

  const insertTextAtCaret = (text) => {
    area.focus();
    let done = false;
    try { done = document.execCommand("insertText", false, text); } catch { done = false; }
    if (!done) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };

  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (def.multiline) insertTextAtCaret("\n");
    }
  });
  area.addEventListener("paste", (e) => {
    e.preventDefault();
    let text = "";
    try { text = e.clipboardData.getData("text/plain") || ""; } catch { text = ""; }
    text = text.replace(/\r\n?/g, "\n");
    if (!def.multiline) text = text.replace(/\n/g, "");
    if (text) insertTextAtCaret(text);
  });
  area.addEventListener("input", () => {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, 400);
  });
  area.addEventListener("blur", () => {
    clearTimeout(commitTimer);
    commit();
  });

  renderRuns(area, runsFromValue(G.values.get(spec.objectId)));
  wrap.append(toolbar, area);
  syncFontSetSelect();
  fieldControls.set(spec.objectId, {
    control: area,
    errorEl: err,
    refresh() {
      renderRuns(area, runsFromValue(G.values.get(spec.objectId)));
      syncFontSetSelect();
    },
  });
  return wrap;
}
