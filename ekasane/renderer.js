// ekasane renderer (alpha)
// EkasaneRenderer: ekasane-renderer.md / ekasane-renderer-lld.md の実装。
// 単一ファイル、ビルドなし。ES モジュールとして EkasaneRenderer を export する。
// 描画は Canvas 2D。公開 API は Canvas を露出しない。

const DEFAULT_FONT_SIZE = 32;
const DEFAULT_FONT_WEIGHT = 400;
const DEFAULT_FONT_COLOR = "#000000FF";
const DEFAULT_FAMILY = ["sans-serif"];
const GENERIC_FAMILIES = new Set([
  "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong",
]);

function ok(data, warning) {
  const r = { success: true, data };
  if (warning !== undefined) r.warning = warning;
  return r;
}

function err(code, message) {
  return { success: false, error: { code, message } };
}

function isFunctionForm(v) {
  return v !== null && typeof v === "object" && Array.isArray(v.function);
}

function isRefForm(v) {
  return isFunctionForm(v) && v.function[0] === "reference";
}

function isAnchorForm(v) {
  return isFunctionForm(v) && v.function[0] === "anchor";
}

// フル形 "ekasane.<category>.<id>" でも省略形 "<id>" でも受ける。
// フル形でカテゴリが違う場合は { ok: false }。
function parseId(raw, category) {
  if (typeof raw !== "string" || raw === "") return { ok: false };
  const m = /^ekasane\.([a-z]+)\.(.+)$/.exec(raw);
  if (m) {
    if (m[1] !== category) return { ok: false };
    return { ok: true, id: m[2] };
  }
  if (raw.startsWith("ekasane.")) return { ok: false };
  return { ok: true, id: raw };
}

function validColor(s, fallback) {
  if (typeof s === "string" && /^#[0-9a-fA-F]{8}$/.test(s)) return s;
  if (typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s)) return s + "FF";
  return fallback;
}

function deg2rad(deg) {
  const n = Number(deg);
  return (Number.isFinite(n) ? n : 0) * Math.PI / 180;
}

export class EkasaneRenderer {
  constructor() {
    this._packageId = null;
    this._templateId = null;
    this._canvas = document.createElement("canvas");
    this._ctx = this._canvas.getContext("2d");
    this._width = 0;
    this._height = 0;
    this._materials = new Map(); // nsKey -> Map<id, { hash }>
    this._decodedPool = new Map(); // hash -> ImageBitmap
    this._fonts = new Map(); // nsKey -> Map<id, { usedFamily, source }>
    this._importedFonts = new Map(); // "name|weight|style" -> FontFace
  }

  _nsKey() {
    return this._packageId + "\u0000" + this._templateId;
  }

  _nsMap(map) {
    const key = this._nsKey();
    let m = map.get(key);
    if (!m) {
      m = new Map();
      map.set(key, m);
    }
    return m;
  }

  _nsGet(map) {
    return map.get(this._nsKey());
  }

  _initialized() {
    return this._packageId !== null && this._templateId !== null;
  }

  // ---------------------------------------------------------------
  // 公開 API
  // ---------------------------------------------------------------

  initPackage(uuid) {
    if (typeof uuid !== "string" || uuid === "") {
      return err("INVALID_ARGUMENT", "initPackage: uuid は空でない文字列で指定してください");
    }
    this._packageId = uuid;
    this._templateId = null;
    return ok(null);
  }

  initImage(template, width, height) {
    if (this._packageId === null) {
      return err("NOT_INITIALIZED", "initImage: initPackage がされていません");
    }
    if (typeof template !== "string" || template === "") {
      return err("INVALID_ARGUMENT", "initImage: template は空でない文字列で指定してください");
    }
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return err("INVALID_ARGUMENT", "initImage: width / height は正の数で指定してください");
    }
    this._templateId = template;
    this._width = w;
    this._height = h;
    this._canvas.width = w;
    this._canvas.height = h;
    return ok(null);
  }

  async importFontFile(fontData) {
    const bytes = await this._toBytes(fontData);
    if (bytes === null) {
      return err("INVALID_ARGUMENT", "importFontFile: フォントデータは Blob または ArrayBuffer で渡してください");
    }
    const info = await this._readFontInfo(bytes);
    if (info === null) {
      return err("FONT_PARSE_FAILED", "importFontFile: フォントファイルから名前を読み取れませんでした");
    }
    let face;
    try {
      // weight / style を descriptor で渡す（無いと全て 400 / normal として登録されてしまう）
      face = new FontFace(info.name, bytes, { weight: String(info.weight), style: info.style });
      await face.load();
    } catch (e) {
      return err("FONT_LOAD_FAILED", "importFontFile: フォントの読み込みに失敗しました: " + (e && e.message ? e.message : e));
    }
    const key = `${info.name}|${info.weight}|${info.style}`;
    const old = this._importedFonts.get(key);
    if (old) document.fonts.delete(old);
    document.fonts.add(face);
    this._importedFonts.set(key, face);
    return ok(info.name);
  }

  async registerFont(id, fontDefinition) {
    if (!this._initialized()) {
      return err("NOT_INITIALIZED", "registerFont: initPackage / initImage がされていません");
    }
    if (typeof id !== "string" || id === "") {
      return err("INVALID_ARGUMENT", "registerFont: id は空でない文字列で指定してください");
    }
    if (!fontDefinition || typeof fontDefinition !== "object" || !Array.isArray(fontDefinition.family)) {
      return err("INVALID_ARGUMENT", "registerFont: fontDefinition.family は配列で指定してください");
    }
    const issues = this._validateRegistration("font", id, fontDefinition);
    const skip = issues.find((i) => i.level === "skip");
    if (skip) return err(skip.code || "INVALID_ARGUMENT", skip.message || "registerFont: 登録できませんでした");

    const family = fontDefinition.family;
    let resolved = this._resolveFamilyList(family);
    let warning;
    if (resolved === null) {
      resolved = { usedFamily: "sans-serif", source: "generic", index: -1 };
      warning = "指定されたフォントはどれも使えないため、「sans-serif」を使用します";
    } else if (resolved.usedFamily !== family[0]) {
      warning = `最優先フォント「${family[0]}」は使えないため、「${resolved.usedFamily}」を使用します`;
    }
    this._nsMap(this._fonts).set(id, { usedFamily: resolved.usedFamily, source: resolved.source });
    return ok(resolved.usedFamily, warning);
  }

  async registerMaterial(id, data) {
    if (!this._initialized()) {
      return err("NOT_INITIALIZED", "registerMaterial: initPackage / initImage がされていません");
    }
    if (typeof id !== "string" || id === "") {
      return err("INVALID_ARGUMENT", "registerMaterial: id は空でない文字列で指定してください");
    }
    if (!(data instanceof Blob)) {
      return err("INVALID_ARGUMENT", "registerMaterial: data は Blob で渡してください");
    }
    const issues = this._validateRegistration("material", id, data);
    const skip = issues.find((i) => i.level === "skip");
    if (skip) return err(skip.code || "INVALID_ARGUMENT", skip.message || "registerMaterial: 登録できませんでした");

    const buffer = await data.arrayBuffer();
    const hash = await this._sha256Hex(buffer);
    if (!this._decodedPool.has(hash)) {
      let bitmap;
      try {
        bitmap = await createImageBitmap(data);
      } catch (e) {
        return err("DECODE_FAILED", "registerMaterial: 画像のデコードに失敗しました: " + (e && e.message ? e.message : e));
      }
      this._decodedPool.set(hash, bitmap);
    }
    this._nsMap(this._materials).set(id, { hash });
    return ok(null);
  }

  render(ekasane) {
    if (!this._initialized()) {
      return err("NOT_INITIALIZED", "render: initPackage / initImage がされていません");
    }
    if (!ekasane || typeof ekasane !== "object" || !ekasane.common ||
        !Number.isFinite(Number(ekasane.common.width)) || !Number.isFinite(Number(ekasane.common.height)) ||
        !(ekasane.object instanceof Map)) {
      return err("INVALID_DATA", "render: 渡されたデータが描画できません（common / object の形が不正です）");
    }
    const warnings = [];
    const ctx = this._ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this._width, this._height);
    const objects = [...ekasane.object.values()];
    objects.sort((a, b) => (Number(a && a.z) || 0) - (Number(b && b.z) || 0));
    for (const obj of objects) {
      try {
        this._drawObject(ekasane, obj, warnings);
      } catch (e) {
        warnings.push({
          id: obj && obj.id !== undefined ? String(obj.id) : "",
          code: "OBJECT_SKIPPED",
          message: "描画中に問題が起きました: " + (e && e.message ? e.message : e),
        });
      }
    }
    return { success: true, warnings };
  }

  async getImage(mimeType) {
    if (this._templateId === null) {
      return err("NOT_INITIALIZED", "getImage: initImage がされていません");
    }
    const type = typeof mimeType === "string" && mimeType !== "" ? mimeType : "image/png";
    let blob;
    try {
      blob = await new Promise((resolve) => this._canvas.toBlob(resolve, type));
    } catch (e) {
      return err("ENCODE_FAILED", "getImage: 画像への変換に失敗しました: " + (e && e.message ? e.message : e));
    }
    if (blob === null) {
      return err("ENCODE_FAILED", "getImage: 画像への変換に失敗しました");
    }
    return ok(blob);
  }

  clearRegistData() {
    if (this._packageId === null && this._templateId === null) {
      return err("NOT_INITIALIZED", "clearRegistData: 初期化されていません");
    }
    for (const bitmap of this._decodedPool.values()) {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
    this._decodedPool.clear();
    this._materials.clear();
    this._fonts.clear();
    for (const face of this._importedFonts.values()) {
      document.fonts.delete(face);
    }
    this._importedFonts.clear();
    this._packageId = null;
    this._templateId = null;
    this._width = 0;
    this._height = 0;
    return ok(null);
  }

  // ---------------------------------------------------------------
  // validation の枠（中身は後のステップで足す。本バージョンは空）
  // ---------------------------------------------------------------

  _validateObject(ekasane, object) {
    return [];
  }

  _validateRegistration(kind, id, data) {
    return [];
  }

  // ---------------------------------------------------------------
  // 内部ヘルパー
  // ---------------------------------------------------------------

  async _toBytes(data) {
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  async _sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // 取り込み済みフォントに、その名前の face が1つでもあるか
  _hasImportedFont(name) {
    for (const key of this._importedFonts.keys()) {
      const i = key.lastIndexOf("|");
      const j = key.lastIndexOf("|", i - 1);
      if (j > 0 && key.slice(0, j) === name) return true;
    }
    return false;
  }

  // 希望リストの先頭から、実際に使えるフォントを1つ決める。
  // 戻り値: { usedFamily, source, index } / どれも使えなければ null
  _resolveFamilyList(family) {
    for (let i = 0; i < family.length; i++) {
      const name = family[i];
      if (typeof name !== "string" || name === "") continue;
      if (this._hasImportedFont(name)) {
        return { usedFamily: name, source: "imported", index: i };
      }
      if (GENERIC_FAMILIES.has(name.toLowerCase())) {
        return { usedFamily: name, source: "generic", index: i };
      }
      let available = false;
      try {
        available = document.fonts.check(`16px "${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
      } catch (e) {
        available = false;
      }
      if (available) {
        return { usedFamily: name, source: "system", index: i };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------
  // フォント情報（名前・weight・style）の読み取り
  // 対応: TTF / OTF / WOFF。TTC は先頭フォントのみ。WOFF2 は未対応。
  // ---------------------------------------------------------------

  async _readFontInfo(bytes) {
    try {
      if (bytes.byteLength < 4) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const tag = view.getUint32(0);
      if (tag === 0x774f4632) return null; // 'wOF2' は未対応
      if (tag === 0x74746366) { // 'ttcf' (TTC)
        if (bytes.byteLength < 16) return null;
        return this._readSfntInfo(view, view.getUint32(12));
      }
      if (tag === 0x774f4646) { // 'wOFF'
        return await this._readWoffInfo(bytes);
      }
      return this._readSfntInfo(view, 0);
    } catch (e) {
      return null;
    }
  }

  _readSfntInfo(view, base) {
    if (base + 12 > view.byteLength) return null;
    const numTables = view.getUint16(base + 4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (rec + 16 > view.byteLength) return null;
      const t = String.fromCharCode(
        view.getUint8(rec), view.getUint8(rec + 1), view.getUint8(rec + 2), view.getUint8(rec + 3));
      tables[t] = { off: view.getUint32(rec + 8), len: view.getUint32(rec + 12) };
    }
    if (!tables["name"]) return null;
    const names = this._parseNameTable(view, tables["name"].off, tables["name"].len);
    if (names === null) return null;
    let os2 = null;
    if (tables["OS/2"]) os2 = this._parseOs2Table(view, tables["OS/2"].off, tables["OS/2"].len);
    let macStyle = 0;
    if (tables["head"] && tables["head"].len >= 46) {
      macStyle = view.getUint16(tables["head"].off + 44);
    }
    return this._fontInfoFrom(names, os2, macStyle);
  }

  // OS/2 テーブルから usWeightClass と fsSelection を読む
  _parseOs2Table(view, off, len) {
    if (off + 6 > view.byteLength || len < 6) return null;
    const weight = view.getUint16(off + 4);
    const fsSelection = len >= 64 && off + 64 <= view.byteLength ? view.getUint16(off + 62) : 0;
    return { weight, fsSelection };
  }

  // 名前・OS/2・head の情報から { name, weight, style } を決める
  _fontInfoFrom(names, os2, macStyle) {
    let weight = null;
    if (os2 && os2.weight >= 1 && os2.weight <= 1000) weight = os2.weight;
    if (weight === null) weight = this._estimateWeight(names.subfamily);
    if (weight === null && os2 && (os2.fsSelection & 0x20)) weight = 700; // fsSelection の BOLD ビット
    if (weight === null && (macStyle & 0x1)) weight = 700; // head.macStyle の Bold ビット
    if (weight === null) weight = 400;
    let style = "normal";
    if ((os2 && (os2.fsSelection & 0x1)) || (macStyle & 0x2)) {
      style = "italic"; // fsSelection の ITALIC ビット / macStyle の Italic ビット
    } else if (names.subfamily) {
      const sub = names.subfamily.toLowerCase();
      if (sub.includes("italic")) style = "italic";
      else if (sub.includes("oblique")) style = "oblique";
    }
    return { name: names.family, weight, style };
  }

  // subfamily 名（"Bold" "SemiBold" 等）から weight を推定する。推定できなければ null
  _estimateWeight(subfamily) {
    if (!subfamily) return null;
    const s = subfamily.toLowerCase().replace(/[\s-]+/g, "");
    if (s.includes("thin") || s.includes("hairline")) return 100;
    if (s.includes("extralight") || s.includes("ultralight")) return 200;
    if (s.includes("semibold") || s.includes("demibold")) return 600;
    if (s.includes("extrabold") || s.includes("ultrabold")) return 800;
    if (s.includes("light")) return 300;
    if (s.includes("black") || s.includes("heavy")) return 900;
    if (s.includes("bold")) return 700;
    if (s.includes("medium")) return 500;
    if (s.includes("regular") || s.includes("normal") || s.includes("book")) return 400;
    return null;
  }

  async _readWoffInfo(bytes) {
    const nameBytes = await this._readWoffTable(bytes, "name");
    if (nameBytes === null) return null;
    const nv = new DataView(nameBytes.buffer, nameBytes.byteOffset, nameBytes.byteLength);
    const names = this._parseNameTable(nv, 0, nameBytes.byteLength);
    if (names === null) return null;
    let os2 = null;
    const os2Bytes = await this._readWoffTable(bytes, "OS/2");
    if (os2Bytes !== null) {
      const ov = new DataView(os2Bytes.buffer, os2Bytes.byteOffset, os2Bytes.byteLength);
      os2 = this._parseOs2Table(ov, 0, os2Bytes.byteLength);
    }
    return this._fontInfoFrom(names, os2, 0);
  }

  // WOFF から指定タグのテーブルを取り出す（zlib 圧縮されていれば解凍する）
  async _readWoffTable(bytes, wanted) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 44) return null;
    const numTables = view.getUint16(12);
    for (let i = 0; i < numTables; i++) {
      const rec = 44 + i * 20;
      if (rec + 20 > bytes.byteLength) return null;
      const t = String.fromCharCode(
        view.getUint8(rec), view.getUint8(rec + 1), view.getUint8(rec + 2), view.getUint8(rec + 3));
      if (t !== wanted) continue;
      const off = view.getUint32(rec + 4);
      const compLen = view.getUint32(rec + 8);
      const origLen = view.getUint32(rec + 12);
      let tableBytes = bytes.subarray(off, off + compLen);
      if (tableBytes.byteLength !== compLen) return null;
      if (compLen !== origLen) {
        if (typeof DecompressionStream === "undefined") return null;
        const stream = new Blob([tableBytes]).stream().pipeThrough(new DecompressionStream("deflate"));
        tableBytes = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      return tableBytes;
    }
    return null;
  }

  _parseNameTable(view, off, len) {
    if (off + 6 > view.byteLength) return null;
    const count = view.getUint16(off + 2);
    const storage = off + view.getUint16(off + 4);
    const records = [];
    for (let i = 0; i < count; i++) {
      const r = off + 6 + i * 12;
      if (r + 12 > view.byteLength) break;
      records.push({
        platform: view.getUint16(r),
        language: view.getUint16(r + 4),
        nameId: view.getUint16(r + 6),
        length: view.getUint16(r + 8),
        offset: view.getUint16(r + 10),
      });
    }
    const score = (r) => {
      if (r.platform === 3) {
        if (r.language === 0x411) return 0; // 日本語
        if (r.language === 0x409) return 1; // 英語
        return 2;
      }
      if (r.platform === 0) return 3;
      if (r.platform === 1) return 4;
      return 5;
    };
    const pick = (ids) => {
      for (const wantId of ids) {
        const cands = records.filter((r) => r.nameId === wantId);
        cands.sort((a, b) => score(a) - score(b));
        for (const r of cands) {
          const s = this._decodeNameString(view, storage + r.offset, r.length, r.platform);
          if (s && s.trim() !== "") return s.trim();
        }
      }
      return null;
    };
    const family = pick([16, 1]);
    if (family === null) return null;
    return { family, subfamily: pick([17, 2]) };
  }

  _decodeNameString(view, off, len, platform) {
    if (off < 0 || len < 0 || off + len > view.byteLength) return null;
    const bytes = new Uint8Array(view.buffer, view.byteOffset + off, len);
    try {
      if (platform === 1) return new TextDecoder("macintosh").decode(bytes);
      return new TextDecoder("utf-16be").decode(bytes);
    } catch (e) {
      let s = "";
      if (platform === 1) {
        for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[i]);
      } else {
        for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return s;
    }
  }

  // ---------------------------------------------------------------
  // 値の解決
  // ---------------------------------------------------------------

  // object のプロパティ1件の実効値を返す。戻り値: { ok, value }
  // 失敗した場合は warnings へ積んで { ok: false } を返す。
  _resolveProperty(ek, obj, prop, warnings) {
    const raw = obj[prop];
    if (!isRefForm(raw)) return { ok: true, value: raw };
    const fail = (code, message) => {
      warnings.push({ id: obj.id, code, message });
      return { ok: false };
    };
    const parsed = parseId(raw.function[1], "object");
    if (!parsed.ok) {
      return fail("REFERENCE_TYPE_MISMATCH", `Reference の id の形式が不正です: ${String(raw.function[1])}`);
    }
    const target = ek.object.get(parsed.id);
    if (!target) {
      return fail("REFERENCE_NOT_FOUND", `Reference の参照先がありません: ${parsed.id}`);
    }
    const targetProp = (prop === "min" || prop === "max") ? "value" : prop;
    if (prop === "value") {
      const allowed = { text: ["numeric", "text"], shape: ["numeric"], image: ["numeric"] }[obj.type] || [];
      if (!allowed.includes(target.type)) {
        return fail("REFERENCE_TYPE_MISMATCH", `Reference の組み合わせが対応表にありません: ${obj.type}.value -> ${target.type}`);
      }
    } else if (prop === "min" || prop === "max") {
      if (target.type !== "numeric") {
        return fail("REFERENCE_TYPE_MISMATCH", `numeric の ${prop} が参照できるのは numeric の value だけです`);
      }
    }
    const targetRaw = target[targetProp];
    if (isRefForm(targetRaw)) {
      return fail("REFERENCE_CHAIN", `Reference の参照先がさらに Reference を使っています: ${parsed.id}`);
    }
    if (prop === "value" && obj.type === "text" && target.type === "numeric") {
      return { ok: true, value: this._formatNumeric(ek, target, warnings) };
    }
    return { ok: true, value: targetRaw };
  }

  // shape / image の value が numeric への Reference の場合に、参照先 object を返す。
  _resolveLinkedNumeric(ek, obj, warnings) {
    const fail = (code, message) => {
      warnings.push({ id: obj.id, code, message });
      return null;
    };
    const parsed = parseId(obj.value.function[1], "object");
    if (!parsed.ok) {
      return fail("REFERENCE_TYPE_MISMATCH", `Reference の id の形式が不正です: ${String(obj.value.function[1])}`);
    }
    const target = ek.object.get(parsed.id);
    if (!target) {
      return fail("REFERENCE_NOT_FOUND", `Reference の参照先がありません: ${parsed.id}`);
    }
    if (target.type !== "numeric") {
      return fail("REFERENCE_TYPE_MISMATCH", `リンク先は numeric でなければなりません: ${parsed.id}`);
    }
    if (isRefForm(target.value)) {
      return fail("REFERENCE_CHAIN", `Reference の参照先がさらに Reference を使っています: ${parsed.id}`);
    }
    return target;
  }

  _resolveAnchor(ek, obj, selfW, selfH, warnings, visited) {
    const fn = obj.anchor.function;
    const fail = (code, message) => {
      warnings.push({ id: obj.id, code, message });
      return null;
    };
    const parsed = parseId(fn[1], "object");
    if (!parsed.ok) {
      return fail("ANCHOR_TARGET_NOT_FOUND", `anchor の相手の id の形式が不正です: ${String(fn[1])}`);
    }
    const target = ek.object.get(parsed.id);
    if (!target) {
      return fail("ANCHOR_TARGET_NOT_FOUND", `anchor の相手がありません: ${parsed.id}`);
    }
    if (visited.has(parsed.id)) {
      return fail("OBJECT_SKIPPED", "anchor が循環しています");
    }
    visited.add(parsed.id);
    const tw = this._resolveProperty(ek, target, "width", warnings);
    const th = this._resolveProperty(ek, target, "height", warnings);
    if (!tw.ok || !th.ok) return null;
    const targetW = Number(tw.value) || 0;
    const targetH = Number(th.value) || 0;
    let tx, ty;
    if (isAnchorForm(target.anchor)) {
      const p = this._resolveAnchor(ek, target, targetW, targetH, warnings, visited);
      if (p === null) return null;
      tx = p.x;
      ty = p.y;
    } else {
      const xr = this._resolveProperty(ek, target, "x", warnings);
      const yr = this._resolveProperty(ek, target, "y", warnings);
      if (!xr.ok || !yr.ok) return null;
      tx = Number(xr.value) || 0;
      ty = Number(yr.value) || 0;
    }
    const pct = (i) => {
      const n = Number(fn[i]);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      x: tx + targetW * pct(2) / 100 - selfW * pct(4) / 100,
      y: ty + targetH * pct(3) / 100 - selfH * pct(5) / 100,
    };
  }

  // numeric の value / min / max / decimal-places を、Reference 解決済みの数値で返す。
  _numericParts(ek, numObj, warnings) {
    const resolveNum = (prop, def) => {
      const raw = numObj[prop];
      if (raw === undefined || raw === null) return def;
      if (isRefForm(raw)) {
        const r = this._resolveProperty(ek, numObj, prop, warnings);
        if (!r.ok) return def;
        const n = Number(r.value);
        return Number.isFinite(n) ? n : def;
      }
      const n = Number(raw);
      return Number.isFinite(n) ? n : def;
    };
    let decimals = Number(numObj["decimal-places"] !== undefined && numObj["decimal-places"] !== null ? numObj["decimal-places"] : 0);
    if (!Number.isFinite(decimals)) decimals = 0;
    decimals = Math.min(20, Math.max(0, Math.trunc(decimals)));
    return {
      value: resolveNum("value", 0),
      min: resolveNum("min", 0),
      max: resolveNum("max", 65535),
      decimals,
    };
  }

  _formatNumeric(ek, numObj, warnings) {
    const parts = this._numericParts(ek, numObj, warnings);
    const fmtRaw = numObj.format;
    if (fmtRaw === "") return ""; // 空文字の format は「描画しない」（値保持専用）
    const fmt = typeof fmtRaw === "string" ? fmtRaw : "{value}";
    const texts = {
      value: parts.value.toFixed(parts.decimals),
      min: parts.min.toFixed(parts.decimals),
      max: parts.max.toFixed(parts.decimals),
    };
    const invalid = (message) => {
      warnings.push({ id: numObj.id, code: "FORMAT_INVALID", message });
      return String(parts.value);
    };
    let out = "";
    for (let i = 0; i < fmt.length; i++) {
      const c = fmt[i];
      if (c === "\\") {
        const n = fmt[i + 1];
        if (n === "{" || n === "}" || n === "\\") {
          out += n;
          i++;
          continue;
        }
        return invalid(`format のエスケープが不正です: ${fmt}`);
      }
      if (c === "{") {
        const end = fmt.indexOf("}", i);
        if (end < 0) return invalid(`format のプレースホルダが閉じていません: ${fmt}`);
        const name = fmt.slice(i + 1, end);
        if (!Object.prototype.hasOwnProperty.call(texts, name)) {
          return invalid(`format に対応していないプレースホルダがあります: {${name}}`);
        }
        out += texts[name];
        i = end;
        continue;
      }
      out += c;
    }
    return out;
  }

  _clipRatio(ek, numObj, warnings) {
    const parts = this._numericParts(ek, numObj, warnings);
    if (parts.max === parts.min) return 0;
    let ratio = (parts.value - parts.min) / (parts.max - parts.min);
    if (ratio < 0 || ratio > 1) {
      warnings.push({
        id: numObj.id,
        code: "VALUE_OUT_OF_RANGE",
        message: `値 ${parts.value} が範囲 ${parts.min}〜${parts.max} の外にあります`,
      });
      ratio = Math.min(1, Math.max(0, ratio));
    }
    return ratio;
  }

  // 割合クリップの矩形を返す（shape / image で共用）。
  _ratioClipRect(obj, x, y, w, h, ratio) {
    const reverse = obj.reverse === true;
    if (obj.vector === "vertical") {
      const keepH = h * ratio;
      return { x, y: reverse ? y : y + (h - keepH), w, h: keepH };
    }
    const keepW = w * ratio;
    return { x: reverse ? x + (w - keepW) : x, y, w: keepW, h };
  }

  // ---------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------

  _drawObject(ek, obj, warnings) {
    if (!obj || typeof obj !== "object") return;
    const issues = this._validateObject(ek, obj);
    let skip = false;
    for (const issue of issues) {
      warnings.push({ id: obj.id, code: issue.code, message: issue.message });
      if (issue.level === "skip") skip = true;
    }
    if (skip) return;

    const wRes = this._resolveProperty(ek, obj, "width", warnings);
    const hRes = this._resolveProperty(ek, obj, "height", warnings);
    if (!wRes.ok || !hRes.ok) return;
    const w = Number(wRes.value);
    const h = Number(hRes.value);

    let x, y;
    if (isAnchorForm(obj.anchor)) {
      const pos = this._resolveAnchor(ek, obj, Number.isFinite(w) ? w : 0, Number.isFinite(h) ? h : 0,
        warnings, new Set([String(obj.id)]));
      if (pos === null) return;
      x = pos.x;
      y = pos.y;
    } else {
      const xRes = this._resolveProperty(ek, obj, "x", warnings);
      const yRes = this._resolveProperty(ek, obj, "y", warnings);
      if (!xRes.ok || !yRes.ok) return;
      x = Number(xRes.value) || 0;
      y = Number(yRes.value) || 0;
    }
    let gw = w;
    let gh = h;
    if (!Number.isFinite(gw) || !Number.isFinite(gh)) {
      if (obj.type === "text" || obj.type === "numeric") {
        // width / height 未指定の text / numeric は pos からそのまま描く（寄せの基準は無し）
        if (!Number.isFinite(gw)) gw = 0;
        if (!Number.isFinite(gh)) gh = 0;
      } else {
        warnings.push({ id: obj.id, code: "OBJECT_SKIPPED", message: "width / height が数値ではありません" });
        return;
      }
    }
    const geom = { x, y, w: gw, h: gh };
    switch (obj.type) {
      case "shape":
        this._drawShape(ek, obj, warnings, geom);
        break;
      case "text": {
        let value = obj.value;
        if (isRefForm(value)) {
          const r = this._resolveProperty(ek, obj, "value", warnings);
          if (!r.ok) return;
          value = r.value;
        }
        this._drawTextValue(ek, obj, value, warnings, geom);
        break;
      }
      case "numeric": {
        const s = this._formatNumeric(ek, obj, warnings);
        if (s !== "") this._drawTextValue(ek, obj, s, warnings, geom);
        break;
      }
      case "image":
        this._drawImage(ek, obj, warnings, geom);
        break;
      default:
        warnings.push({ id: obj.id, code: "OBJECT_SKIPPED", message: `未対応の type です: ${String(obj.type)}` });
    }
  }

  _drawShape(ek, obj, warnings, geom) {
    const ctx = this._ctx;
    const { x, y, w, h } = geom;
    ctx.save();
    if (isRefForm(obj.value)) {
      const numObj = this._resolveLinkedNumeric(ek, obj, warnings);
      if (numObj === null) {
        ctx.restore();
        return;
      }
      const ratio = this._clipRatio(ek, numObj, warnings);
      const r = this._ratioClipRect(obj, x, y, w, h, ratio);
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
    }
    ctx.beginPath();
    switch (obj.figure) {
      case "rect":
        ctx.rect(x, y, w, h);
        break;
      case "roundRect": {
        let radii = [0, 0, 0, 0];
        if (Array.isArray(obj.radii) && obj.radii.length === 4 &&
            obj.radii.every((v) => Number.isFinite(Number(v)))) {
          radii = obj.radii.map((v) => Math.max(0, Number(v)));
        }
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(x, y, w, h, radii);
        } else {
          ctx.rect(x, y, w, h);
        }
        break;
      }
      case "arc": {
        const cx = x + w / 2;
        const cy = y + h / 2;
        const r = Math.min(w, h) / 2;
        ctx.arc(cx, cy, r, deg2rad(obj["start-angle"] !== undefined ? obj["start-angle"] : 0),
          deg2rad(obj["end-angle"] !== undefined ? obj["end-angle"] : 360), obj.counterclockwise === true);
        ctx.closePath();
        break;
      }
      case "ellipse": {
        const cx = x + w / 2;
        const cy = y + h / 2;
        ctx.ellipse(cx, cy, Math.abs(w / 2), Math.abs(h / 2), deg2rad(obj.rotation || 0),
          deg2rad(obj["start-angle"] !== undefined ? obj["start-angle"] : 0),
          deg2rad(obj["end-angle"] !== undefined ? obj["end-angle"] : 360), obj.counterclockwise === true);
        break;
      }
      default:
        warnings.push({ id: obj.id, code: "OBJECT_SKIPPED", message: `未対応の figure です: ${String(obj.figure)}` });
        ctx.restore();
        return;
    }
    const fillColor = validColor(obj["fill-color"], "#00000000");
    if (!fillColor.endsWith("00")) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    const borderWidth = obj["border-width"] === undefined ? 3 : Number(obj["border-width"]);
    if (Number.isFinite(borderWidth) && borderWidth > 0) {
      ctx.strokeStyle = validColor(obj["border-color"], "#000000FF");
      ctx.lineWidth = borderWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  _fontString(style) {
    const family = String(style.usedFamily).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${style.italic ? "italic " : ""}${style.weight} ${style.size}px "${family}"`;
  }

  _drawTextValue(ek, obj, value, warnings, geom) {
    const ctx = this._ctx;
    // フォントの土台（object の font 定義）
    let def = null;
    let defId = null;
    if (typeof obj.font === "string" && obj.font !== "") {
      const parsed = parseId(obj.font, "font");
      if (parsed.ok) {
        defId = parsed.id;
        def = ek.font instanceof Map ? (ek.font.get(parsed.id) || null) : null;
      }
      if (!def) {
        warnings.push({ id: obj.id, code: "FONT_DEFINITION_NOT_FOUND", message: `font 定義がありません: ${obj.font}` });
      }
    }
    const base = {
      familyList: def && Array.isArray(def.family) ? def.family : DEFAULT_FAMILY,
      size: def && Number.isFinite(Number(def.size)) ? Number(def.size) : DEFAULT_FONT_SIZE,
      weight: def && def.weight !== undefined && def.weight !== null ? def.weight : DEFAULT_FONT_WEIGHT,
      color: def && typeof def.color === "string" ? def.color : DEFAULT_FONT_COLOR,
      italic: false,
      usedFamily: null,
    };
    if (def && defId !== null) {
      const reg = this._nsGet(this._fonts);
      if (reg && reg.has(defId)) base.usedFamily = reg.get(defId).usedFamily;
    }
    if (base.usedFamily === null) {
      const res = this._resolveFamilyList(base.familyList);
      base.usedFamily = res ? res.usedFamily : "sans-serif";
    }

    // ランの正規化と実効スタイルの決定
    let rawRuns;
    if (typeof value === "string") rawRuns = [{ text: value }];
    else if (typeof value === "number") rawRuns = [{ text: String(value) }];
    else if (Array.isArray(value)) rawRuns = value;
    else rawRuns = [{ text: "" }];
    let fallbackWarned = false;
    const styled = [];
    for (const run of rawRuns) {
      if (!run || typeof run !== "object") continue;
      const st = { ...base };
      if (typeof run.set === "string" && run.set !== "") {
        const parsed = parseId(run.set, "font");
        const setDef = parsed.ok && ek.font instanceof Map ? (ek.font.get(parsed.id) || null) : null;
        if (setDef) {
          if (Array.isArray(setDef.family)) st.familyList = setDef.family;
          if (setDef.size !== undefined && setDef.size !== null) st.size = Number(setDef.size) || st.size;
          if (setDef.weight !== undefined && setDef.weight !== null) st.weight = setDef.weight;
          if (typeof setDef.color === "string") st.color = setDef.color;
          const reg = this._nsGet(this._fonts);
          st.usedFamily = reg && reg.has(parsed.id) ? reg.get(parsed.id).usedFamily : null;
        } else {
          warnings.push({ id: obj.id, code: "FONT_DEFINITION_NOT_FOUND", message: `font 定義がありません: ${run.set}` });
        }
      } else {
        if (Array.isArray(run.family)) st.familyList = run.family;
        if (run.size !== undefined && run.size !== null) st.size = Number(run.size) || st.size;
        if (run.weight !== undefined && run.weight !== null) st.weight = run.weight;
        if (typeof run.color === "string") st.color = run.color;
      }
      if (run.italic !== undefined && run.italic !== null) st.italic = !!run.italic;
      if (!st.usedFamily) {
        const res = this._resolveFamilyList(st.familyList);
        st.usedFamily = res ? res.usedFamily : "sans-serif";
        if (res && res.index > 0 && Array.isArray(run.family) && !fallbackWarned) {
          warnings.push({
            id: obj.id,
            code: "FONT_FALLBACK",
            message: `最優先フォント「${st.familyList[0]}」は使えないため、「${res.usedFamily}」を使用します`,
          });
          fallbackWarned = true;
        }
      }
      const text = typeof run.text === "string"
        ? run.text.replace(/[\u0000-\u001F\u007F]/g, "")
        : (run.text === undefined || run.text === null ? "" : String(run.text));
      styled.push({ text, style: st, newline: run.newline === true });
    }

    // 行への分割（newline ランで改行）
    let lines = [[]];
    for (const seg of styled) {
      lines[lines.length - 1].push(seg);
      if (seg.newline) lines.push([]);
    }
    if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();

    if (obj["auto-linebreak"] === true && geom.w > 0) {
      lines = this._wrapLines(lines, geom.w);
    }
    const maxLine = Number(obj["max-line"] || 0);
    if (maxLine > 0 && lines.length > maxLine) {
      warnings.push({ id: obj.id, code: "TEXT_OVERFLOW", message: `行数が max-line (${maxLine}) を超えました` });
      lines = lines.slice(0, maxLine);
    }

    // 行ごとの幅と高さを先に測る（align / vertical-align のため）
    const lineWidths = lines.map((line) => line.reduce((sum, seg) => {
      if (seg.text === "") return sum;
      ctx.font = this._fontString(seg.style);
      return sum + ctx.measureText(seg.text).width;
    }, 0));
    // 行の高さ：line-height の指定があればその値（全行共通）。
    // 省略時は max（font 定義の size, その行の最大ラン size）。係数は付けない。
    const specifiedLH = Number(obj["line-height"]);
    const hasLH = Number.isFinite(specifiedLH) && specifiedLH > 0;
    const lineHeights = lines.map((line) => {
      if (hasLH) return specifiedLH;
      return line.reduce((m, s) => Math.max(m, s.style.size), base.size);
    });
    const blockHeight = lineHeights.reduce((a, b) => a + b, 0);

    // align / vertical-align は text と numeric（format 適用後の文字列）に効く
    const alignValue = obj.align;
    const valignValue = obj["vertical-align"];

    // vertical-align: テキストブロック全体を height の中で寄せる
    let cy = geom.y;
    if (geom.h > 0) {
      if (valignValue === "middle") cy += (geom.h - blockHeight) / 2;
      else if (valignValue === "bottom") cy += geom.h - blockHeight;
    }

    ctx.save();
    ctx.textBaseline = "top";
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      // align: その行の描画幅を width の中で寄せる
      let cx = geom.x;
      if (geom.w > 0) {
        if (alignValue === "center") cx += (geom.w - lineWidths[li]) / 2;
        else if (alignValue === "right") cx += geom.w - lineWidths[li];
      }
      for (const seg of line) {
        if (seg.text === "") continue;
        ctx.font = this._fontString(seg.style);
        ctx.fillStyle = validColor(seg.style.color, DEFAULT_FONT_COLOR);
        ctx.fillText(seg.text, cx, cy);
        cx += ctx.measureText(seg.text).width;
      }
      cy += lineHeights[li];
    }
    ctx.restore();
  }

  // auto-linebreak 用の折り返し。行の幅が maxWidth を超える前に文字単位で割る。
  _wrapLines(lines, maxWidth) {
    const ctx = this._ctx;
    const out = [];
    for (const line of lines) {
      let cur = [];
      let curW = 0;
      for (const seg of line) {
        ctx.font = this._fontString(seg.style);
        let rest = seg.text;
        while (rest.length > 0) {
          let take = 0;
          let w = 0;
          while (take < rest.length) {
            const chW = ctx.measureText(rest[take]).width;
            if (curW + w + chW > maxWidth && (cur.length > 0 || take > 0)) break;
            w += chW;
            take++;
          }
          if (take === 0) {
            if (cur.length > 0) {
              out.push(cur);
              cur = [];
              curW = 0;
              continue;
            }
            take = 1;
            w = ctx.measureText(rest[0]).width;
          }
          cur.push({ ...seg, text: rest.slice(0, take) });
          curW += w;
          rest = rest.slice(take);
          if (rest.length > 0) {
            out.push(cur);
            cur = [];
            curW = 0;
          }
        }
      }
      out.push(cur);
    }
    return out;
  }

  _drawImage(ek, obj, warnings, geom) {
    const ctx = this._ctx;
    const { x, y, w, h } = geom;
    // 使う material の id の決定
    let ratio = null;
    let materialRaw;
    if (isRefForm(obj.value)) {
      const numObj = this._resolveLinkedNumeric(ek, obj, warnings);
      if (numObj === null) return;
      ratio = this._clipRatio(ek, numObj, warnings);
      materialRaw = obj["material-id"];
    } else if (typeof obj.value === "string" && obj.value !== "") {
      materialRaw = obj.value;
    } else {
      materialRaw = obj["material-id"];
    }
    if (typeof materialRaw !== "string" || materialRaw === "") {
      warnings.push({ id: obj.id, code: "MATERIAL_NOT_FOUND", message: "material の id が指定されていません" });
      return;
    }
    const parsed = parseId(materialRaw, "material");
    if (!parsed.ok) {
      warnings.push({ id: obj.id, code: "MATERIAL_NOT_FOUND", message: `material の id の形式が不正です: ${materialRaw}` });
      return;
    }
    const id = parsed.id;
    const nsMaterials = this._nsGet(this._materials);
    const entry = nsMaterials ? nsMaterials.get(id) : undefined;
    if (!entry) {
      const hasDef = ek.material instanceof Map && ek.material.has(id);
      warnings.push({
        id: obj.id,
        code: hasDef ? "MATERIAL_NOT_REGISTERED" : "MATERIAL_NOT_FOUND",
        message: hasDef ? `material が登録されていません: ${id}` : `material がありません: ${id}`,
      });
      return;
    }
    const bitmap = this._decodedPool.get(entry.hash);
    if (!bitmap) {
      warnings.push({ id: obj.id, code: "MATERIAL_NOT_REGISTERED", message: `material が登録されていません: ${id}` });
      return;
    }
    // 切り出し元の決定（material 定義の trimming -> object の trimming）
    let sx = 0;
    let sy = 0;
    let sw = bitmap.width;
    let sh = bitmap.height;
    const def = ek.material instanceof Map ? ek.material.get(id) : undefined;
    const applyTrim = (t) => {
      const nx = sx + (Number(t.x) || 0);
      const ny = sy + (Number(t.y) || 0);
      const nw = Number(t.width);
      const nh = Number(t.height);
      sx = Math.max(0, Math.min(nx, bitmap.width));
      sy = Math.max(0, Math.min(ny, bitmap.height));
      sw = Number.isFinite(nw) ? Math.max(0, Math.min(nw, bitmap.width - sx)) : sw;
      sh = Number.isFinite(nh) ? Math.max(0, Math.min(nh, bitmap.height - sy)) : sh;
    };
    if (def && def.trimming && typeof def.trimming === "object") applyTrim(def.trimming);
    if (obj.trimming && typeof obj.trimming === "object") applyTrim(obj.trimming);
    if (sw <= 0 || sh <= 0) return;
    const zoom = def && Number.isFinite(Number(def.zoom)) ? Number(def.zoom) : 100;
    const virtualW = sw * zoom / 100;
    const virtualH = sh * zoom / 100;

    ctx.save();
    if (ratio !== null) {
      const r = this._ratioClipRect(obj, x, y, w, h, ratio);
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
    }
    if (obj.overflow === "clip") {
      const scale = Math.min(w / virtualW, h / virtualH);
      const dw = virtualW * scale;
      const dh = virtualH * scale;
      ctx.drawImage(bitmap, sx, sy, sw, sh, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(bitmap, sx, sy, sw, sh, x, y, virtualW, virtualH);
    }
    ctx.restore();
  }
}
