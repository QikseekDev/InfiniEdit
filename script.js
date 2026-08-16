(function(){
"use strict";

/* =========================================================================
   DEFAULT SAVE — shown automatically on a visitor's first visit (before
   any autosave exists in their browser). A deep clone is used as the
   starting point so this constant is never mutated.
   ========================================================================= */
const DEFAULT_SAVE_DATA = {"name":"Save 1","version":"1.0","created":1783875699379,"updated":0,"instances":[],"items":[{"id":0,"text":"Water","emoji":"💧"},{"id":1,"text":"Fire","emoji":"🔥"},{"id":2,"text":"Wind","emoji":"🌬️"},{"id":3,"text":"Earth","emoji":"🌍"}]};

/* =========================================================================
   STATE
   ========================================================================= */
const state = {
  save: null,            // {name, version, created, updated, instances, items}
  filePath: null,
  history: [],           // undo stack of save snapshots (JSON strings)
  future: [],            // redo stack
  selectedId: null,      // currently inspected element id
  selectedIds: new Set(),// multi-select for bulk ops
  search: "",
  filters: { dup:false, dead:false, first:false, unreachable:false, custom:false, noRecipe:false },
  sort: { key: "id", dir: "asc" },
  centerTab: "elements",
  graph: {
    nodes: new Map(), // id -> {x,y,vx,vy}
    zoom: 1, panX: 0, panY: 0,
    showLabels: true, showEmoji: true,
    dragNode: null, panning: false, lastMouse: null,
    selected: null,
    width: 800, height: 300
  },
  darkmode: true,
  lowEndMode: false, // when true, graph view is fully disabled and its space reclaimed
  recipeFilterElement: null, // when set from inspector, filter recipe tab to this element
};

const BASE_ELEMENT_NAMES = new Set(["Water","Fire","Wind","Earth"]);

function clone(o){ return JSON.parse(JSON.stringify(o)); }
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

/* =========================================================================
   TOAST
   ========================================================================= */
function toast(msg, type){
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = "toast" + (type ? " "+type : "");
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .25s"; setTimeout(()=>el.remove(),260); }, 2600);
}

/* Global safety net: surface otherwise-silent errors instead of failing
   invisibly. Existing try/catch blocks around specific operations (file
   load, export, etc.) still handle their own errors first; this only
   catches what falls outside them. */
window.addEventListener("error", (e)=>{
  console.error("Unhandled error:", e.error || e.message);
  toast("Something went wrong: " + ((e.error && e.error.message) || e.message || "unknown error"), "error");
});
window.addEventListener("unhandledrejection", (e)=>{
  console.error("Unhandled promise rejection:", e.reason);
  toast("Something went wrong: " + ((e.reason && e.reason.message) || String(e.reason)), "error");
});

/* =========================================================================
   GZIP (DEFLATE) — minimal pure-JS implementation for decode + encode
   We implement a raw DEFLATE decoder/encoder (stored + dynamic-free,
   using fixed Huffman for encode and full inflate for decode) wrapped
   in gzip framing, since no external libraries are allowed.
   We prefer native CompressionStream/DecompressionStream ("gzip") when
   available (modern Chrome/Edge/Firefox/Safari) and fall back to a
   pure-JS implementation otherwise.
   ========================================================================= */
const GZ = (function(){

  async function nativeAvailable(){
    return typeof window.DecompressionStream === "function" && typeof window.CompressionStream === "function";
  }

  async function gunzipNative(u8){
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function gzipNative(u8){
    const cs = new CompressionStream("gzip");
    const stream = new Blob([u8]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /* ---------------- Pure JS fallback: INFLATE ---------------- */
  function inflateRaw(data, startOffset){
    let pos = startOffset*8; // bit position
    const out = [];
    function getBit(){
      const byteIndex = pos >>> 3;
      const bit = (data[byteIndex] >>> (pos & 7)) & 1;
      pos++;
      return bit;
    }
    function getBits(n){
      let v = 0;
      for(let i=0;i<n;i++) v |= getBit() << i;
      return v;
    }
    function alignByte(){ pos = (pos + 7) & ~7; }

    // Build Huffman decode table from code lengths array
    function buildHuffman(lengths){
      const maxBits = Math.max(0, ...lengths);
      const blCount = new Array(maxBits+1).fill(0);
      for(const l of lengths) if(l>0) blCount[l]++;
      const nextCode = new Array(maxBits+1).fill(0);
      let code = 0;
      for(let bits=1; bits<=maxBits; bits++){
        code = (code + blCount[bits-1]) << 1;
        nextCode[bits] = code;
      }
      const codes = new Array(lengths.length).fill(0);
      for(let n=0;n<lengths.length;n++){
        const len = lengths[n];
        if(len>0){ codes[n] = nextCode[len]; nextCode[len]++; }
      }
      // map: for decoding, build a tree as nested object keyed by bit-string is slow;
      // instead use a map from (len,code)->symbol via length-grouped dict for speed.
      const table = new Map(); // key: len*100000+code -> symbol
      for(let n=0;n<lengths.length;n++){
        if(lengths[n]>0){
          table.set(lengths[n]*1000000+codes[n], n);
        }
      }
      return {table, maxBits};
    }
    function decodeSymbol(huff){
      let code = 0, len = 0;
      while(len < huff.maxBits+1){
        code = (code<<1) | getBit();
        len++;
        const sym = huff.table.get(len*1000000+code);
        if(sym !== undefined) return sym;
      }
      throw new Error("Invalid huffman code");
    }

    const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    const LEN_EXTRA= [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    const DIST_BASE= [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    const DIST_EXTRA=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

    let finalBlock = false;
    while(!finalBlock){
      finalBlock = getBit() === 1;
      const btype = getBits(2);
      if(btype === 0){
        // stored
        alignByte();
        const byteIndex = pos>>>3;
        const len = data[byteIndex] | (data[byteIndex+1]<<8);
        pos += 32; // skip LEN and NLEN
        const start = pos>>>3;
        for(let i=0;i<len;i++) out.push(data[start+i]);
        pos += len*8;
      } else if(btype === 1 || btype === 2){
        let litHuff, distHuff;
        if(btype === 1){
          // fixed huffman
          const litLengths = new Array(288);
          for(let i=0;i<144;i++) litLengths[i]=8;
          for(let i=144;i<256;i++) litLengths[i]=9;
          for(let i=256;i<280;i++) litLengths[i]=7;
          for(let i=280;i<288;i++) litLengths[i]=8;
          const distLengths = new Array(30).fill(5);
          litHuff = buildHuffman(litLengths);
          distHuff = buildHuffman(distLengths);
        } else {
          const hlit = getBits(5)+257;
          const hdist = getBits(5)+1;
          const hclen = getBits(4)+4;
          const ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
          const clLengths = new Array(19).fill(0);
          for(let i=0;i<hclen;i++) clLengths[ORDER[i]] = getBits(3);
          const clHuff = buildHuffman(clLengths);
          const lengths = [];
          while(lengths.length < hlit+hdist){
            const sym = decodeSymbol(clHuff);
            if(sym < 16){ lengths.push(sym); }
            else if(sym === 16){
              const rep = getBits(2)+3;
              const prev = lengths[lengths.length-1];
              for(let i=0;i<rep;i++) lengths.push(prev);
            } else if(sym === 17){
              const rep = getBits(3)+3;
              for(let i=0;i<rep;i++) lengths.push(0);
            } else {
              const rep = getBits(7)+11;
              for(let i=0;i<rep;i++) lengths.push(0);
            }
          }
          const litLengths = lengths.slice(0, hlit);
          const distLengths = lengths.slice(hlit, hlit+hdist);
          litHuff = buildHuffman(litLengths);
          distHuff = buildHuffman(distLengths);
        }
        while(true){
          const sym = decodeSymbol(litHuff);
          if(sym < 256){ out.push(sym); }
          else if(sym === 256){ break; }
          else {
            const idx = sym-257;
            const len = LEN_BASE[idx] + getBits(LEN_EXTRA[idx]);
            const dsym = decodeSymbol(distHuff);
            const dist = DIST_BASE[dsym] + getBits(DIST_EXTRA[dsym]);
            const startIdx = out.length - dist;
            for(let i=0;i<len;i++) out.push(out[startIdx+i]);
          }
        }
      } else {
        throw new Error("Unsupported block type");
      }
    }
    return new Uint8Array(out);
  }

  function gunzipPureJS(u8){
    if(u8[0] !== 0x1f || u8[1] !== 0x8b) throw new Error("Not a gzip file");
    const flg = u8[3];
    let offset = 10;
    if(flg & 0x04){ const xlen = u8[offset] | (u8[offset+1]<<8); offset += 2+xlen; }
    if(flg & 0x08){ while(u8[offset] !== 0) offset++; offset++; }
    if(flg & 0x10){ while(u8[offset] !== 0) offset++; offset++; }
    if(flg & 0x02){ offset += 2; }
    return inflateRaw(u8, offset);
  }

  /* ---------------- Pure JS fallback: DEFLATE (store + fixed huffman) + GZIP wrap ---------------- */
  function crc32(u8){
    let c, crc = 0xFFFFFFFF;
    const table = crc32.table || (crc32.table = (function(){
      const t = new Uint32Array(256);
      for(let n=0;n<256;n++){
        c = n;
        for(let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
        t[n] = c;
      }
      return t;
    })());
    for(let i=0;i<u8.length;i++){
      crc = table[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Simple deflate: emit stored blocks (type 0). Valid, decompressible DEFLATE,
  // just without compression ratio benefits. This guarantees correctness.
  function deflateStore(u8){
    const blocks = [];
    const MAXLEN = 65535;
    let i = 0;
    if(u8.length === 0){
      // one empty final stored block
      blocks.push({final:true, data:new Uint8Array(0)});
    }
    while(i < u8.length){
      const remaining = u8.length - i;
      const len = Math.min(MAXLEN, remaining);
      const chunk = u8.subarray(i, i+len);
      const final = (i+len) >= u8.length;
      blocks.push({final, data:chunk});
      i += len;
    }
    // bit writer
    const bytes = [];
    let bitBuf = 0, bitCount = 0;
    function writeBit(b){
      bitBuf |= (b&1) << bitCount;
      bitCount++;
      if(bitCount === 8){ bytes.push(bitBuf); bitBuf=0; bitCount=0; }
    }
    function writeBits(v,n){ for(let k=0;k<n;k++) writeBit((v>>>k)&1); }
    function alignByte(){ if(bitCount>0){ bytes.push(bitBuf); bitBuf=0; bitCount=0; } }

    for(const blk of blocks){
      writeBit(blk.final ? 1:0);
      writeBits(0,2); // type 0 = stored
      alignByte();
      const len = blk.data.length;
      const nlen = (~len) & 0xFFFF;
      bytes.push(len & 0xFF, (len>>>8)&0xFF, nlen & 0xFF, (nlen>>>8)&0xFF);
      for(let k=0;k<blk.data.length;k++) bytes.push(blk.data[k]);
    }
    return new Uint8Array(bytes);
  }

  function gzipPureJS(u8){
    const header = new Uint8Array([0x1f,0x8b,0x08,0x00,0,0,0,0,0,0xff]);
    const deflated = deflateStore(u8);
    const crc = crc32(u8);
    const size = u8.length >>> 0;
    const footer = new Uint8Array(8);
    footer[0]=crc&0xFF; footer[1]=(crc>>>8)&0xFF; footer[2]=(crc>>>16)&0xFF; footer[3]=(crc>>>24)&0xFF;
    footer[4]=size&0xFF; footer[5]=(size>>>8)&0xFF; footer[6]=(size>>>16)&0xFF; footer[7]=(size>>>24)&0xFF;
    const result = new Uint8Array(header.length + deflated.length + footer.length);
    result.set(header,0);
    result.set(deflated, header.length);
    result.set(footer, header.length+deflated.length);
    return result;
  }

  async function gunzip(u8){
    if(await nativeAvailable()){
      try{ return await gunzipNative(u8); }
      catch(e){ console.warn("native gunzip failed, falling back", e); }
    }
    return gunzipPureJS(u8);
  }
  async function gzip(u8){
    if(await nativeAvailable()){
      try{ return await gzipNative(u8); }
      catch(e){ console.warn("native gzip failed, falling back", e); }
    }
    return gzipPureJS(u8);
  }

  return { gunzip, gzip };
})();

/* =========================================================================
   SAVE FORMAT HELPERS
   ========================================================================= */
function newEmptySave(){
  return { name:"New Save", version:"1.0", created:Date.now(), updated:Date.now(), instances:[], items:[] };
}

/* Sets or removes the "discovery": 1 flag on an item, matching Infinite Craft's
   own save schema. When set, the key is positioned immediately before "recipes"
   (rebuilding the object to control key order, since JS preserves insertion order
   and JSON.stringify follows it). When unset, the key is removed entirely so
   elements without the flag look exactly like the original save format. */
function setDiscoveryFlag(item, isFirst){
  if(isFirst){
    const rebuilt = {};
    for(const k of Object.keys(item)){
      if(k === "recipes" || k === "discovery") continue;
      rebuilt[k] = item[k];
    }
    rebuilt.discovery = 1;
    rebuilt.recipes = item.recipes || [];
    for(const k of Object.keys(item)) delete item[k];
    Object.assign(item, rebuilt);
  } else {
    delete item.discovery;
  }
}

function itemsById(save){
  const m = new Map();
  for(const it of save.items) m.set(it.id, it);
  return m;
}

function nextFreeId(save){
  let max = -1;
  for(const it of save.items) max = Math.max(max, it.id);
  return max+1;
}

/* Build derived analysis of the save. Memoized: cached by (save reference)
   and invalidated whenever the save is mutated (see markSaveDirty()). */
let _analysisCache = null;
let _analysisFor = null;
function markSaveDirty(){ _analysisCache = null; _analysisFor = null; _byIdCache = null; _byIdFor = null; }
let _byIdCache = null, _byIdFor = null;
const _origItemsById = itemsById;
itemsById = function(save){
  if(save === _byIdFor && _byIdCache) return _byIdCache;
  _byIdCache = _origItemsById(save);
  _byIdFor = save;
  return _byIdCache;
};

function analyze(save){
  if(save === _analysisFor && _analysisCache) return _analysisCache;
  const items = save.items;
  const byId = itemsById(save);
  const nameCount = new Map();
  for(const it of items){
    const key = it.text.trim().toLowerCase();
    nameCount.set(key, (nameCount.get(key)||0)+1);
  }
  const ingredientUsage = new Map();
  const usedAsResultBy = new Map();
  let totalRecipes = 0;
  const missingDeps = [];

  // Reachability worklist: unsat[itemId:recipeIdx] = # missing ingredients still unreachable.
  const roots = new Set();
  const reachable = new Set();
  const dep = new Map(); // ingredientId -> [{itemId, key}]
  const unsat = new Map();

  for(const it of items){
    const recipes = it.recipes || [];
    if(recipes.length === 0){
      roots.add(it.id);
      reachable.add(it.id);
    }
    for(let idx=0; idx<recipes.length; idx++){
      const r = recipes[idx];
      totalRecipes++;
      const key = it.id + ":" + idx;
      let missing = 0;
      for(let k=0;k<r.length;k++){
        const ingId = r[k];
        ingredientUsage.set(ingId, (ingredientUsage.get(ingId)||0)+1);
        if(!byId.has(ingId)){
          missingDeps.push({itemId: it.id, ingredientId: ingId});
          // treat missing-ingredient recipes as never-satisfiable
          missing++;
        } else {
          if(!usedAsResultBy.has(ingId)) usedAsResultBy.set(ingId, new Set());
          usedAsResultBy.get(ingId).add(it.id);
          if(!dep.has(ingId)) dep.set(ingId, []);
          dep.get(ingId).push({itemId: it.id, key});
          missing++;
        }
      }
      unsat.set(key, missing);
    }
  }
  // BFS/worklist propagation of reachability
  const queue = [...roots];
  while(queue.length){
    const id = queue.pop();
    const deps = dep.get(id);
    if(!deps) continue;
    for(let d=0; d<deps.length; d++){
      const info = deps[d];
      if(reachable.has(info.itemId)) continue;
      const c = unsat.get(info.key) - 1;
      unsat.set(info.key, c);
      if(c === 0){
        reachable.add(info.itemId);
        queue.push(info.itemId);
      }
    }
  }

  const unreachable = items.filter(it => !reachable.has(it.id) && it.recipes && it.recipes.length>0);
  const deadEnds = items.filter(it => !ingredientUsage.has(it.id));
  const duplicates = items.filter(it => nameCount.get(it.text.trim().toLowerCase()) > 1);
  const noRecipeItems = items.filter(it => !it.recipes || it.recipes.length===0);
  const firstDiscoveries = items.filter(it => it.discovery === 1 || BASE_ELEMENT_NAMES.has(it.text));
  const customElements = items.filter(it => (!it.recipes || it.recipes.length===0) && !BASE_ELEMENT_NAMES.has(it.text) && it.discovery !== 1);

  const usageList = [...ingredientUsage.entries()]
    .map(([id,count]) => ({id, count, item: byId.get(id)}))
    .filter(x=>x.item)
    .sort((a,b)=>b.count-a.count);

  const totalElements = items.length;
  const avgRecipes = totalElements ? (totalRecipes/totalElements) : 0;

  const result = {
    byId, totalElements, totalRecipes, avgRecipes,
    duplicates, deadEnds, unreachable, missingDeps, noRecipeItems,
    firstDiscoveries, customElements, usageList, reachable, roots,
    usedAsResultBy, ingredientUsage
  };
  _analysisCache = result;
  _analysisFor = save;
  return result;
}
/* =========================================================================
   HISTORY (undo/redo)
   ========================================================================= */
function pushHistory(){
  if(!state.save) return;
  state.history.push(JSON.stringify(state.save));
  if(state.history.length > 100) state.history.shift();
  state.future = [];
  markSaveDirty();
  updateUndoRedoButtons();
}
function undo(){
  if(state.history.length === 0) return;
  if(!state.save) return;
  state.future.push(JSON.stringify(state.save));
  const prev = state.history.pop();
  state.save = JSON.parse(prev);
  markSaveDirty();
  fullRender();
  toast("Undid last change");
  updateUndoRedoButtons();
  autosave();
}
function redo(){
  if(state.future.length === 0) return;
  state.history.push(JSON.stringify(state.save));
  const next = state.future.pop();
  state.save = JSON.parse(next);
  markSaveDirty();
  fullRender();
  toast("Redid change");
  updateUndoRedoButtons();
  autosave();
}
function updateUndoRedoButtons(){
  document.getElementById("btn-undo").disabled = state.history.length===0;
  document.getElementById("btn-redo").disabled = state.future.length===0;
}
function commit(label){
  // call BEFORE mutation via pushHistory(); this is called AFTER mutation for bookkeeping
  state.save.updated = Date.now();
  markSaveDirty();
  autosave();
}

/* =========================================================================
   AUTOSAVE / LOCALSTORAGE
   ========================================================================= */
const LS_AUTOSAVE = "icse_autosave_v1";
const LS_BACKUPS = "icse_backups_v1";
const LS_THEME = "icse_theme_v1";
const LS_LOWEND = "icse_lowend_v1";

function autosave(){
  try{
    if(state.save) localStorage.setItem(LS_AUTOSAVE, JSON.stringify(state.save));
  }catch(e){ console.warn("autosave failed", e); }
}
function loadAutosave(){
  try{
    const raw = localStorage.getItem(LS_AUTOSAVE);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return null;
}
function getBackups(){
  try{
    const raw = localStorage.getItem(LS_BACKUPS);
    return raw ? JSON.parse(raw) : [];
  }catch(e){ return []; }
}
function saveBackups(list){
  try{ localStorage.setItem(LS_BACKUPS, JSON.stringify(list)); }catch(e){
    toast("Could not save backup (storage full?)", "error");
  }
}
function createBackup(){
  if(!state.save){ toast("Nothing to back up", "error"); return; }
  const list = getBackups();
  list.unshift({ id: uid(), at: Date.now(), name: state.save.name, data: state.save });
  if(list.length > 20) list.pop();
  saveBackups(list);
  toast("Backup created");
  renderBackupsModalIfOpen();
}

/* =========================================================================
   FILE I/O
   ========================================================================= */
async function openFileObject(file){
  try{
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    let jsonBytes;
    if(u8[0]===0x1f && u8[1]===0x8b){
      jsonBytes = await GZ.gunzip(u8);
    } else {
      jsonBytes = u8; // allow loading raw JSON too
    }
    const text = new TextDecoder("utf-8").decode(jsonBytes);
    const data = JSON.parse(text);
    if(!data.items || !Array.isArray(data.items)) throw new Error("Not a recognized Infinite Craft save (missing items array)");
    state.save = data;
    markSaveDirty();
    state.history = [];
    state.future = [];
    state.selectedId = null;
    state.selectedIds.clear();
    state.filePath = file.name;
    fullRender();
    toast("Loaded "+file.name, "success");
    autosave();
  }catch(e){
    console.error(e);
    toast("Failed to open file: "+e.message, "error");
  }
}

async function exportIc(){
  if(!state.save){ toast("Nothing to export", "error"); return; }
  try{
    const json = JSON.stringify(state.save);
    const bytes = new TextEncoder().encode(json);
    const gz = await GZ.gzip(bytes);
    downloadBlob(new Blob([gz], {type:"application/octet-stream"}), (state.save.name||"save").replace(/[^a-z0-9_\- ]/gi,"_")+".ic");
    toast("Exported .ic", "success");
  }catch(e){
    console.error(e);
    toast("Export failed: "+e.message, "error");
  }
}
function exportJson(){
  if(!state.save){ toast("Nothing to export", "error"); return; }
  const json = JSON.stringify(state.save, null, 2);
  downloadBlob(new Blob([json], {type:"application/json"}), (state.save.name||"save").replace(/[^a-z0-9_\- ]/gi,"_")+".json");
  toast("Exported JSON", "success");
}
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
}

/* =========================================================================
   MODAL SYSTEM
   ========================================================================= */
let _modalPreviouslyFocused = null;
function openModal({title, bodyHtml, footerButtons, wide, onMount}){
  closeModal();
  _modalPreviouslyFocused = document.activeElement;
  const root = document.getElementById("modal-root");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "active-modal-overlay";
  overlay.innerHTML = `
    <div class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title-heading" tabindex="-1">
      <div class="modal-header"><h3 id="modal-title-heading">${title}</h3><button class="modal-close" id="modal-close-x" aria-label="Close dialog">×</button></div>
      <div class="modal-body" id="modal-body-content">${bodyHtml}</div>
      <div class="modal-footer" id="modal-footer-content"></div>
    </div>`;
  root.appendChild(overlay);
  const footer = overlay.querySelector("#modal-footer-content");
  (footerButtons||[]).forEach(btn=>{
    const b = document.createElement("button");
    b.className = "tbtn" + (btn.primary?" primary":"") + (btn.danger?" danger":"");
    b.textContent = btn.label;
    b.onclick = btn.onClick;
    footer.appendChild(b);
  });
  overlay.querySelector("#modal-close-x").onclick = closeModal;
  overlay.addEventListener("mousedown", (e)=>{ if(e.target===overlay) closeModal(); });
  if(onMount) onMount(overlay);
  document.addEventListener("keydown", modalEscHandler);
  document.addEventListener("keydown", modalFocusTrapHandler);
  const modalEl = overlay.querySelector(".modal");
  const focusable = modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  (focusable[0] || modalEl).focus();
}
function modalEscHandler(e){ if(e.key === "Escape") closeModal(); }
function modalFocusTrapHandler(e){
  if(e.key !== "Tab") return;
  const overlay = document.getElementById("active-modal-overlay");
  if(!overlay) return;
  const focusable = Array.from(overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el=>!el.disabled && el.offsetParent !== null);
  if(focusable.length === 0) return;
  const first = focusable[0], last = focusable[focusable.length-1];
  if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
}
function closeModal(){
  const el = document.getElementById("active-modal-overlay");
  if(el) el.remove();
  document.removeEventListener("keydown", modalEscHandler);
  document.removeEventListener("keydown", modalFocusTrapHandler);
  if(_modalPreviouslyFocused && _modalPreviouslyFocused.focus) _modalPreviouslyFocused.focus();
  _modalPreviouslyFocused = null;
}

const COMMON_EMOJI = ["💧","🔥","🌬️","🌍","🌫️","🌪️","🏖️","🌵","🌀","🌊","🌋","🏔️","💨","💩","🏝️","🏜️","🗿","🐫","🧩","🪐","☁️","🌧️","🌈","💥","✨","⚡","🌱","🌳","🪨","🧱","🏠","🚗","🐍","🐉","👽","🤖","💎","🪙","📦","🧪","🔮","🦠","🧬","🌑","🌕","☀️","⭐","🍄","🐦","🐟","🐛","🦋"];

/* =========================================================================
   ELEMENT CRUD
   ========================================================================= */
function addElement(){
  const autoId = nextFreeId(state.save);
  openModal({
    title: "Add Element",
    bodyHtml: `
      <label class="field-label">Name</label>
      <div class="ingredient-picker">
        <input class="field-input" id="f-name" placeholder="e.g. Lava" autocomplete="off">
        <div class="ingredient-results" id="f-name-suggest" style="display:none;"></div>
      </div>
      <label class="field-label">Emoji</label>
      <div class="emoji-input-row">
        <input class="field-input" id="f-emoji" placeholder="🔥" maxlength="4">
        <input class="field-input search-input" id="f-emoji-search" placeholder="search common emoji…">
      </div>
      <div class="emoji-picker-list" id="emoji-picker"></div>
      <div class="small muted" style="margin-top:10px;">ID <code>#${autoId}</code> will be assigned automatically.</div>
      <label class="field-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;margin-top:14px;">
        <input type="checkbox" id="f-first-discovery" style="cursor:pointer;width:16px;height:16px;">
        <span>Mark as first discovery</span>
      </label>
      <div class="small muted">Adds <code>"discovery": 1</code> to this element in the save file.</div>
      <label class="field-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;margin-top:14px;">
        <input type="checkbox" id="f-auto-recipe" checked style="cursor:pointer;width:16px;height:16px;">
        <span>🔍 Auto-fetch recipe from InfiniBrowser API</span>
      </label>
      <div class="small muted">Same lookup as API Lookup, but applied automatically once the element is added.</div>
    `,
    footerButtons: [
      {label:"Paste recipes instead", onClick: ()=>{ closeModal(); openImportRecipesModal(); }},
      {label:"Cancel", onClick: closeModal},
      {label:"Add Element", primary:true, onClick: async ()=>{
        const name = document.getElementById("f-name").value.trim();
        const emoji = document.getElementById("f-emoji").value.trim() || "❓";
        const isFirst = document.getElementById("f-first-discovery").checked;
        const autoRecipe = document.getElementById("f-auto-recipe").checked;
        if(!name){ toast("Name is required","error"); return; }
        const id = nextFreeId(state.save);
        pushHistory();
        const newItem = {id, text:name, emoji, recipes:[]};
        if(isFirst) setDiscoveryFlag(newItem, true);
        state.save.items.push(newItem);
        commit();
        fullRender();
        closeModal();
        toast("Added "+name, "success");
        if(autoRecipe){
          toast(`Looking up recipe for ${name} on InfiniBrowser…`);
          await autoImportRecipeFor(name);
        }
      }}
    ],
    onMount: (overlay)=>{
      const picker = overlay.querySelector("#emoji-picker");
      function renderPicker(filter){
        picker.innerHTML = "";
        COMMON_EMOJI.filter(e=>!filter || true).forEach(e=>{
          const span = document.createElement("span");
          span.textContent = e;
          span.onclick = ()=>{ document.getElementById("f-emoji").value = e; };
          picker.appendChild(span);
        });
      }
      renderPicker();
      const nameInput = overlay.querySelector("#f-name");
      const nameSuggest = overlay.querySelector("#f-name-suggest");
      wireInfiniBrowserAutocomplete(nameInput, nameSuggest, (name, emoji)=>{
        nameInput.value = name;
        if(emoji) document.getElementById("f-emoji").value = emoji;
      });
      nameInput.focus();
    }
  });
}

function editElement(id){
  const it = state.save.items.find(x=>x.id===id);
  if(!it) return;
  const isFirstDiscovery = it.discovery === 1;
  openModal({
    title: "Edit Element",
    bodyHtml: `
      <label class="field-label">Name</label>
      <input class="field-input" id="f-name" value="${escapeAttr(it.text)}">
      <label class="field-label">Emoji</label>
      <div class="emoji-input-row">
        <input class="field-input" id="f-emoji" value="${escapeAttr(it.emoji)}" maxlength="4">
      </div>
      <div class="emoji-picker-list" id="emoji-picker"></div>
      <label class="field-label">ID</label>
      <input class="field-input" id="f-id" type="number" value="${it.id}">
      <div class="small muted" style="margin-top:4px;">Changing the ID will update all recipes referencing it.</div>
      <label class="field-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;margin-top:14px;">
        <input type="checkbox" id="f-first-discovery" ${isFirstDiscovery?'checked':''} style="cursor:pointer;width:16px;height:16px;">
        <span>Mark as first discovery</span>
      </label>
      <div class="small muted">Adds <code>"discovery": 1</code> to this element in the save file (the flag Infinite Craft uses for elements you discovered first, before <code>recipes</code>).</div>
    `,
    footerButtons: [
      {label:"Cancel", onClick: closeModal},
      {label:"Save Changes", primary:true, onClick: ()=>{
        const name = document.getElementById("f-name").value.trim();
        const emoji = document.getElementById("f-emoji").value.trim() || "❓";
        const newId = parseInt(document.getElementById("f-id").value, 10);
        const isFirst = document.getElementById("f-first-discovery").checked;
        if(!name){ toast("Name is required","error"); return; }
        if(newId !== id && state.save.items.some(x=>x.id===newId)){ toast("ID already in use","error"); return; }
        pushHistory();
        if(newId !== id){
          // update all recipe references across all items
          for(const other of state.save.items){
            for(const r of (other.recipes||[])){
              for(let i=0;i<r.length;i++) if(r[i]===id) r[i]=newId;
            }
          }
          it.id = newId;
        }
        it.text = name; it.emoji = emoji;
        setDiscoveryFlag(it, isFirst);
        commit();
        if(state.selectedId === id) state.selectedId = newId;
        fullRender();
        closeModal();
        toast("Saved changes", "success");
      }},
    ],
    onMount: (overlay)=>{
      const picker = overlay.querySelector("#emoji-picker");
      COMMON_EMOJI.forEach(e=>{
        const span = document.createElement("span");
        span.textContent = e;
        span.onclick = ()=>{ document.getElementById("f-emoji").value = e; };
        picker.appendChild(span);
      });
      document.getElementById("f-name").focus();
    }
  });
}

/* Removes any recipe (on any item) that uses one of the given ids as an
   ingredient. Called automatically before removing elements so recipes
   never point at ingredients that no longer exist. Returns how many
   recipes were removed, for the toast message. */
function removeRecipesReferencing(ids){
  const idSet = new Set(ids);
  let removed = 0;
  state.save.items.forEach(x=>{
    if(!x.recipes || !x.recipes.length) return;
    const before = x.recipes.length;
    x.recipes = x.recipes.filter(r=>!r.some(rid=>idSet.has(rid)));
    removed += before - x.recipes.length;
  });
  return removed;
}

function deleteElement(id, opts){
  opts = opts || {};
  const it = state.save.items.find(x=>x.id===id);
  if(!it) return;
  const usedIn = state.save.items.filter(x => (x.recipes||[]).some(r=>r.includes(id)));
  const recipeCount = usedIn.reduce((n,x)=> n + x.recipes.filter(r=>r.includes(id)).length, 0);
  const warnMsg = recipeCount ? `<p class="small muted">This will also remove ${recipeCount} recipe(s) that use it as an ingredient.</p>` : "";
  openModal({
    title: "Delete Element",
    bodyHtml: `<p>Delete <strong>${escapeHtml(it.emoji)} ${escapeHtml(it.text)}</strong> (id ${it.id})? This cannot be undone except via Undo.</p>${warnMsg}`,
    footerButtons: [
      {label:"Cancel", onClick: closeModal},
      {label:"Delete", danger:true, onClick: ()=>{
        pushHistory();
        const removedRecipes = removeRecipesReferencing([id]);
        state.save.items = state.save.items.filter(x=>x.id!==id);
        if(state.selectedId === id) state.selectedId = null;
        commit();
        fullRender();
        closeModal();
        toast("Deleted "+it.text+(removedRecipes ? " and "+removedRecipes+" recipe(s) using it" : ""), "success");
      }}
    ]
  });
}

function bulkDelete(){
  if(state.selectedIds.size===0){ toast("No elements selected","error"); return; }
  const n = state.selectedIds.size;
  openModal({
    title: "Bulk Delete",
    bodyHtml: `<p>Delete <strong>${n}</strong> selected element(s)? Any recipes using them will also be removed. This cannot be undone except via Undo.</p>`,
    footerButtons: [
      {label:"Cancel", onClick: closeModal},
      {label:"Delete All", danger:true, onClick: ()=>{
        pushHistory();
        const removedRecipes = removeRecipesReferencing([...state.selectedIds]);
        state.save.items = state.save.items.filter(x=>!state.selectedIds.has(x.id));
        state.selectedIds.clear();
        state.selectedId = null;
        commit();
        fullRender();
        closeModal();
        toast("Deleted "+n+" elements"+(removedRecipes ? " and "+removedRecipes+" recipe(s)" : ""), "success");
      }}
    ]
  });
}

/* =========================================================================
   DEDUPE: merge elements that are 100% identical — same name text (exact,
   case-sensitive, symbols included) AND same emoji. Looser near-duplicates
   (different casing/emoji, the existing "Duplicate" tag) are left alone.
   ========================================================================= */
function findExactDuplicateGroups(save){
  const groups = new Map(); // "text\u0001emoji" -> items[]
  for(const it of save.items){
    const key = it.text + "\u0001" + it.emoji;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.values()].filter(g=>g.length>1);
}
function recipePairKey(r){ return [...r].sort((a,b)=>a-b).join(","); }

function openDedupeModal(){
  if(!state.save){ toast("Open or create a save file first", "error"); return; }
  const groups = findExactDuplicateGroups(state.save);
  if(groups.length===0){
    toast("No exact duplicates found — every name+emoji is unique", "success");
    return;
  }
  const totalLosers = groups.reduce((s,g)=>s+g.length-1, 0);
  openModal({
    title: "Dedupe Elements",
    wide: true,
    bodyHtml: `
      <p class="small muted">Found <strong>${groups.length}</strong> set(s) of exact duplicates (same name, emoji, and symbols) — <strong>${totalLosers}</strong> element(s) will be merged away. The kept element in each set keeps its first-discovery flag and combined recipes; every recipe elsewhere that pointed at a merged-away id will be repointed automatically.</p>
      <div class="stat-list" style="max-height:280px;overflow-y:auto;margin-top:10px;">
        ${groups.map(g=>{
          const canonical = g.find(it=>it.discovery===1) || g.reduce((a,b)=>a.id<b.id?a:b);
          const losers = g.filter(it=>it.id!==canonical.id);
          return `<div class="stat-list-row" style="align-items:flex-start;">
            <span class="k">${escapeHtml(canonical.emoji)} ${escapeHtml(canonical.text)}</span>
            <span class="v muted">keep #${canonical.id}, merge ${losers.map(l=>"#"+l.id).join(", ")}</span>
          </div>`;
        }).join("")}
      </div>
    `,
    footerButtons: [
      {label:"Cancel", onClick: closeModal},
      {label:`Merge ${totalLosers} duplicate(s)`, primary:true, onClick: ()=>{
        applyDedupe(groups);
        closeModal();
      }}
    ]
  });
}

function applyDedupe(groups){
  pushHistory();
  const idRemap = new Map(); // loserId -> canonicalId

  for(const group of groups){
    const canonical = group.find(it=>it.discovery===1) || group.reduce((a,b)=>a.id<b.id?a:b);
    const losers = group.filter(it=>it.id!==canonical.id);

    // merge recipes from every loser into the canonical, deduping unordered pairs
    const seen = new Set((canonical.recipes||[]).map(recipePairKey));
    const merged = [...(canonical.recipes||[])];
    for(const loser of losers){
      for(const r of (loser.recipes||[])){
        const k = recipePairKey(r);
        if(!seen.has(k)){ seen.add(k); merged.push(r); }
      }
    }
    canonical.recipes = merged;
    if(group.some(it=>it.discovery===1)) canonical.discovery = 1;

    for(const loser of losers) idRemap.set(loser.id, canonical.id);
  }

  // repoint every ingredient reference at the merged-away ids, then re-dedupe
  // each item's own recipe list (remapping can create fresh exact-pair dupes)
  for(const it of state.save.items){
    if(!it.recipes || !it.recipes.length) continue;
    const remapped = it.recipes.map(r => r.map(ingId => idRemap.has(ingId) ? idRemap.get(ingId) : ingId));
    const seen = new Set();
    it.recipes = remapped.filter(r=>{
      const k = recipePairKey(r);
      if(seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const loserIds = new Set(idRemap.keys());
  state.save.items = state.save.items.filter(it=>!loserIds.has(it.id));

  if(state.selectedId!=null && loserIds.has(state.selectedId)) state.selectedId = idRemap.get(state.selectedId);
  if(state.selectedIds.size){
    const remappedSel = new Set();
    for(const id of state.selectedIds) remappedSel.add(loserIds.has(id) ? idRemap.get(id) : id);
    state.selectedIds = remappedSel;
  }

  commit();
  fullRender();
  toast(`Merged ${loserIds.size} duplicate element(s) into ${groups.length} unique element(s)`, "success");
}

function bulkEdit(){
  if(state.selectedIds.size===0){ toast("No elements selected","error"); return; }
  openModal({
    title: "Bulk Edit ("+state.selectedIds.size+" selected)",
    bodyHtml: `
      <label class="field-label">Set Emoji (optional — leave blank to skip)</label>
      <input class="field-input" id="f-emoji" placeholder="leave blank to skip" maxlength="4">
      <label class="field-label">Name find &amp; replace (optional)</label>
      <div class="modal-row">
        <div><input class="field-input" id="f-find" placeholder="find text"></div>
        <div><input class="field-input" id="f-replace" placeholder="replace with"></div>
      </div>
    `,
    footerButtons: [
      {label:"Cancel", onClick: closeModal},
      {label:"Apply", primary:true, onClick: ()=>{
        const emoji = document.getElementById("f-emoji").value.trim();
        const find = document.getElementById("f-find").value;
        const replace = document.getElementById("f-replace").value;
        pushHistory();
        let count = 0;
        for(const it of state.save.items){
          if(!state.selectedIds.has(it.id)) continue;
          if(emoji){ it.emoji = emoji; count++; }
          if(find){ it.text = it.text.split(find).join(replace); count++; }
        }
        commit();
        fullRender();
        closeModal();
        toast("Bulk edit applied", "success");
      }}
    ]
  });
}

/* =========================================================================
   RECIPE CRUD
   ========================================================================= */
function ingredientPickerHtml(inputId){
  return `<div class="ingredient-picker">
    <input class="field-input" id="${inputId}" placeholder="search element…" autocomplete="off">
    <input type="hidden" id="${inputId}-id">
    <div class="ingredient-results" id="${inputId}-results" style="display:none;"></div>
  </div>`;
}
function wireIngredientPicker(inputId){
  const input = document.getElementById(inputId);
  const hidden = document.getElementById(inputId+"-id");
  const results = document.getElementById(inputId+"-results");
  function show(list){
    if(list.length===0){ results.style.display="none"; return; }
    results.innerHTML = list.slice(0,30).map(it=>
      `<div class="opt" data-id="${it.id}"><span class="em">${escapeHtml(it.emoji)}</span><span>${escapeHtml(it.text)}</span><span class="id">#${it.id}</span></div>`
    ).join("");
    results.style.display="block";
    results.querySelectorAll(".opt").forEach(opt=>{
      opt.onclick = ()=>{
        const id = parseInt(opt.dataset.id,10);
        const item = state.save.items.find(x=>x.id===id);
        input.value = item.emoji+" "+item.text;
        hidden.value = id;
        results.style.display="none";
      };
    });
  }
  input.addEventListener("input", ()=>{
    hidden.value = "";
    const q = input.value.trim().toLowerCase();
    if(!q){ results.style.display="none"; return; }
    const list = state.save.items.filter(it=>it.text.toLowerCase().includes(q) || String(it.id)===q);
    show(list);
  });
  input.addEventListener("focus", ()=>{
    if(input.value.trim()) input.dispatchEvent(new Event("input"));
  });
  document.addEventListener("click", (e)=>{
    if(!results.contains(e.target) && e.target!==input) results.style.display="none";
  });
}

function addRecipe(presetResultId){
  openModal({
    title: "Add Recipe",
    bodyHtml: `
      <label class="field-label">Ingredient A</label>
      ${ingredientPickerHtml("f-ing-a")}
      <label class="field-label">Ingredient B</label>
      ${ingredientPickerHtml("f-ing-b")}
      <label class="field-label">Result</label>
      ${ingredientPickerHtml("f-result")}
    `,
    footerButtons: [
      {label:"Cancel", onClick: closeModal},
      {label:"Add Recipe", primary:true, onClick: ()=>{
        const a = parseInt(document.getElementById("f-ing-a-id").value,10);
        const b = parseInt(document.getElementById("f-ing-b-id").value,10);
        const r = parseInt(document.getElementById("f-result-id").value,10);
        if(isNaN(a)||isNaN(b)||isNaN(r)){ toast("Pick all three elements from the list","error"); return; }
        const resultItem = state.save.items.find(x=>x.id===r);
        pushHistory();
        if(!resultItem.recipes) resultItem.recipes = [];
        resultItem.recipes.push([a,b]);
        commit();
        fullRender();
        closeModal();
        toast("Recipe added", "success");
      }}
    ],
    onMount: ()=>{
      wireIngredientPicker("f-ing-a");
      wireIngredientPicker("f-ing-b");
      wireIngredientPicker("f-result");
      if(presetResultId!=null){
        const item = state.save.items.find(x=>x.id===presetResultId);
        if(item){
          document.getElementById("f-result").value = item.emoji+" "+item.text;
          document.getElementById("f-result-id").value = item.id;
        }
      }
    }
  });
}

function editRecipe(resultId, recipeIndex){
  const item = state.save.items.find(x=>x.id===resultId);
  if(!item) return;
  const recipe = item.recipes[recipeIndex];
  openModal({
    title: "Edit Recipe",
    bodyHtml: `
      <label class="field-label">Ingredient A</label>
      ${ingredientPickerHtml("f-ing-a")}
      <label class="field-label">Ingredient B</label>
      ${ingredientPickerHtml("f-ing-b")}
      <label class="field-label">Result</label>
      ${ingredientPickerHtml("f-result")}
    `,
    footerButtons: [
      {label:"Cancel", onClick: closeModal},
      {label:"Delete Recipe", danger:true, onClick: ()=>{
        pushHistory();
        item.recipes.splice(recipeIndex,1);
        commit();
        fullRender();
        closeModal();
        toast("Recipe deleted", "success");
      }},
      {label:"Save Changes", primary:true, onClick: ()=>{
        const a = parseInt(document.getElementById("f-ing-a-id").value,10);
        const b = parseInt(document.getElementById("f-ing-b-id").value,10);
        const r = parseInt(document.getElementById("f-result-id").value,10);
        if(isNaN(a)||isNaN(b)||isNaN(r)){ toast("Pick all three elements from the list","error"); return; }
        pushHistory();
        if(r !== resultId){
          item.recipes.splice(recipeIndex,1);
          const newResult = state.save.items.find(x=>x.id===r);
          if(!newResult.recipes) newResult.recipes=[];
          newResult.recipes.push([a,b]);
        } else {
          item.recipes[recipeIndex] = [a,b];
        }
        commit();
        fullRender();
        closeModal();
        toast("Recipe updated", "success");
      }}
    ],
    onMount: ()=>{
      wireIngredientPicker("f-ing-a");
      wireIngredientPicker("f-ing-b");
      wireIngredientPicker("f-result");
      const a = state.save.items.find(x=>x.id===recipe[0]);
      const b = state.save.items.find(x=>x.id===recipe[1]);
      const r = item;
      if(a){ document.getElementById("f-ing-a").value = a.emoji+" "+a.text; document.getElementById("f-ing-a-id").value=a.id; }
      else { document.getElementById("f-ing-a").value = "Missing #"+recipe[0]; }
      if(b){ document.getElementById("f-ing-b").value = b.emoji+" "+b.text; document.getElementById("f-ing-b-id").value=b.id; }
      else { document.getElementById("f-ing-b").value = "Missing #"+recipe[1]; }
      document.getElementById("f-result").value = r.emoji+" "+r.text;
      document.getElementById("f-result-id").value = r.id;
    }
  });
}

function findDuplicateRecipes(save){
  const dupes = [];
  for(const it of save.items){
    const seen = new Map();
    (it.recipes||[]).forEach((r, idx)=>{
      const key = [...r].sort((x,y)=>x-y).join(",");
      if(seen.has(key)){
        dupes.push({itemId: it.id, indices:[seen.get(key), idx]});
      } else {
        seen.set(key, idx);
      }
    });
  }
  return dupes;
}

/* =========================================================================
   ESCAPE HELPERS
   ========================================================================= */
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s){ return escapeHtml(s); }

/* =========================================================================
   RENDER: LEFT SIDEBAR (stats / filters / search)
   ========================================================================= */
function renderLeftSidebar(){
  const body = document.getElementById("left-panel-body");
  if(!state.save){
    body.innerHTML = `<div class="empty-state"><p>Open a save file to begin.</p></div>`;
    return;
  }
  const a = analyze(state.save);

  body.innerHTML = `
    <div class="section" data-section="search">
      <div class="section-title"><span>Search</span></div>
      <div class="section-content">
        <div class="search-wrap">
          <span class="icon">🔍</span>
          <input class="search-input" id="search-box" placeholder="Search name, emoji, or id…" value="${escapeAttr(state.search)}">
        </div>
      </div>
    </div>

    <div class="section" data-section="filters">
      <div class="section-title"><span class="chev">▾</span> Filters</div>
      <div class="section-content">
        <div class="filter-chip-row">
          <div class="chip ${state.filters.dup?'active':''}" data-filter="dup">Duplicates <span class="count">${a.duplicates.length}</span></div>
          <div class="chip ${state.filters.dead?'active':''}" data-filter="dead">Dead ends <span class="count">${a.deadEnds.length}</span></div>
          <div class="chip ${state.filters.first?'active':''}" data-filter="first">First discoveries <span class="count">${a.firstDiscoveries.length}</span></div>
          <div class="chip ${state.filters.unreachable?'active':''}" data-filter="unreachable">Unreachable <span class="count">${a.unreachable.length}</span></div>
          <div class="chip ${state.filters.custom?'active':''}" data-filter="custom">Custom <span class="count">${a.customElements.length}</span></div>
          <div class="chip ${state.filters.noRecipe?'active':''}" data-filter="noRecipe">No recipes <span class="count">${a.noRecipeItems.length}</span></div>
        </div>
        ${Object.values(state.filters).some(Boolean) ? `<button class="btn-text" id="clear-filters" style="margin-top:8px;">Clear all filters</button>` : ""}
      </div>
    </div>

    <div class="section" data-section="stats">
      <div class="section-title"><span class="chev">▾</span> Statistics</div>
      <div class="section-content">
        <div class="stat-grid">
          <div class="stat-card"><div class="num">${a.totalElements}</div><div class="lbl">Total elements</div></div>
          <div class="stat-card"><div class="num">${a.totalRecipes}</div><div class="lbl">Total recipes</div></div>
          <div class="stat-card"><div class="num">${a.avgRecipes.toFixed(2)}</div><div class="lbl">Avg recipes / element</div></div>
          <div class="stat-card"><div class="num">${a.firstDiscoveries.length}</div><div class="lbl">First discoveries</div></div>
          <div class="stat-card ${a.duplicates.length?'warn':''}"><div class="num">${a.duplicates.length}</div><div class="lbl">Duplicate elements</div></div>
          <div class="stat-card ${a.deadEnds.length?'warn':''}"><div class="num">${a.deadEnds.length}</div><div class="lbl">Dead ends</div></div>
          <div class="stat-card ${a.unreachable.length?'danger':''}"><div class="num">${a.unreachable.length}</div><div class="lbl">Unreachable</div></div>
          <div class="stat-card ${a.missingDeps.length?'danger':''}"><div class="num">${a.missingDeps.length}</div><div class="lbl">Missing deps</div></div>
          <div class="stat-card full"><div class="num">${a.noRecipeItems.length}</div><div class="lbl">Elements with no recipes</div></div>
        </div>
      </div>
    </div>

    <div class="section" data-section="usage">
      <div class="section-title"><span class="chev">▾</span> Most Used Ingredients</div>
      <div class="section-content">
        <div class="stat-list">
          ${a.usageList.slice(0,12).map(u=>`
            <div class="stat-list-row clickable-row" data-goto="${u.id}">
              <span class="k">${escapeHtml(u.item.emoji)} ${escapeHtml(u.item.text)}</span>
              <span class="v">${u.count}</span>
            </div>`).join("") || '<div class="muted small">No recipe data yet.</div>'}
        </div>
      </div>
    </div>

    <div class="section collapsed" data-section="missing">
      <div class="section-title"><span class="chev">▾</span> Missing Dependencies</div>
      <div class="section-content">
        <div class="stat-list">
          ${a.missingDeps.slice(0,30).map(m=>{
            const it = a.byId.get(m.itemId);
            return `<div class="stat-list-row clickable-row" data-goto="${m.itemId}">
              <span class="k">${it?escapeHtml(it.emoji)+" "+escapeHtml(it.text):"#"+m.itemId} needs</span>
              <span class="v" style="color:var(--danger)">#${m.ingredientId}</span>
            </div>`;
          }).join("") || '<div class="muted small">No missing dependencies. ✓</div>'}
        </div>
      </div>
    </div>
  `;

  // wire events
  {
    const _sb = document.getElementById("search-box");
    let _searchTimer = null;
    _sb.addEventListener("input", (e)=>{
      const v = e.target.value;
      if(_searchTimer) clearTimeout(_searchTimer);
      _searchTimer = setTimeout(()=>{ state.search = v; renderCenter(); }, 140);
    });
  }
  body.querySelectorAll(".chip").forEach(chip=>{
    chip.addEventListener("click", ()=>{
      const f = chip.dataset.filter;
      state.filters[f] = !state.filters[f];
      renderLeftSidebar();
      renderCenter();
    });
  });
  const clearBtn = document.getElementById("clear-filters");
  if(clearBtn) clearBtn.addEventListener("click", ()=>{
    Object.keys(state.filters).forEach(k=>state.filters[k]=false);
    renderLeftSidebar(); renderCenter();
  });
  body.querySelectorAll(".section-title").forEach(t=>{
    t.addEventListener("click", ()=>{
      t.closest(".section").classList.toggle("collapsed");
    });
  });
  body.querySelectorAll("[data-goto]").forEach(row=>{
    row.addEventListener("click", ()=>{
      const id = parseInt(row.dataset.goto,10);
      selectElement(id);
    });
  });
}

/* =========================================================================
   RENDER: CENTER (element table / recipe list)
   ========================================================================= */
function getFilteredItems(){
  if(!state.save) return [];
  const a = analyze(state.save);
  const dupIds = new Set(a.duplicates.map(x=>x.id));
  const deadIds = new Set(a.deadEnds.map(x=>x.id));
  const firstIds = new Set(a.firstDiscoveries.map(x=>x.id));
  const unreachIds = new Set(a.unreachable.map(x=>x.id));
  const customIds = new Set(a.customElements.map(x=>x.id));
  const noRecipeIds = new Set(a.noRecipeItems.map(x=>x.id));

  let items = state.save.items.slice();

  const q = state.search.trim().toLowerCase();
  if(q){
    items = items.filter(it =>
      it.text.toLowerCase().includes(q) ||
      it.emoji.includes(q) ||
      String(it.id)===q ||
      ("#"+it.id)===q
    );
  }
  if(state.filters.dup) items = items.filter(it=>dupIds.has(it.id));
  if(state.filters.dead) items = items.filter(it=>deadIds.has(it.id));
  if(state.filters.first) items = items.filter(it=>firstIds.has(it.id));
  if(state.filters.unreachable) items = items.filter(it=>unreachIds.has(it.id));
  if(state.filters.custom) items = items.filter(it=>customIds.has(it.id));
  if(state.filters.noRecipe) items = items.filter(it=>noRecipeIds.has(it.id));

  const {key, dir} = state.sort;
  items.sort((x,y)=>{
    let vx, vy;
    if(key==="id"){ vx=x.id; vy=y.id; }
    else if(key==="name"){ vx=x.text.toLowerCase(); vy=y.text.toLowerCase(); }
    else if(key==="recipes"){ vx=(x.recipes||[]).length; vy=(y.recipes||[]).length; }
    else if(key==="used"){ vx=a.ingredientUsage.get(x.id)||0; vy=a.ingredientUsage.get(y.id)||0; }
    if(vx<vy) return dir==="asc"?-1:1;
    if(vx>vy) return dir==="asc"?1:-1;
    return 0;
  });
  return {items, a, dupIds, deadIds, firstIds, unreachIds, customIds, noRecipeIds};
}


/* Simple row virtualizer: renders only rows visible in the scroll container
   plus an overscan. Assumes fixed row height. Rerender on scroll via rAF. */
function virtualizeRows(scrollEl, tbody, rows, rowH, buildHtml, tagName){
  tagName = tagName || "tr";
  const overscan = 10;
  let raf = 0, lastStart = -1, lastEnd = -1;
  const total = rows.length;
  function spacer(h){
    if(tagName === "tr"){
      // Use a colspan cell so the height reserves table space cleanly.
      return `<tr class="vspacer"><td colspan="99" style="height:${h}px"></td></tr>`;
    }
    return `<div class="recipe-vspacer" style="height:${h}px"></div>`;
  }
  function paint(force){
    raf = 0;
    const vh = scrollEl.clientHeight || 600;
    const st = scrollEl.scrollTop;
    let start = Math.max(0, Math.floor(st / rowH) - overscan);
    let end   = Math.min(total, Math.ceil((st + vh) / rowH) + overscan);
    if(!force && start === lastStart && end === lastEnd) return;
    lastStart = start; lastEnd = end;
    let html = "";
    if(start > 0) html += spacer(start * rowH);
    for(let i = start; i < end; i++) html += buildHtml(rows[i], i);
    if(end < total) html += spacer((total - end) * rowH);
    tbody.innerHTML = html;
  }
  function schedule(){ if(!raf) raf = requestAnimationFrame(()=>paint(false)); }
  scrollEl.addEventListener("scroll", schedule, {passive:true});
  // Handle resize / initial layout
  const ro = ("ResizeObserver" in window) ? new ResizeObserver(schedule) : null;
  if(ro) ro.observe(scrollEl);
  paint(true);
  return { schedule, destroy(){ scrollEl.removeEventListener("scroll", schedule); if(ro) ro.disconnect(); } };
}

function renderCenter(){
  const content = document.getElementById("center-content");
  const toolbar = document.getElementById("center-toolbar");
  if(!state.save){
    toolbar.innerHTML = "";
    content.innerHTML = `<div class="empty-state">
      <div class="big">🧪</div>
      <h3>No save loaded</h3>
      <p>Open an Infinite Craft <code>.ic</code> file, or drag and drop one anywhere on this page.</p>
    </div>`;
    return;
  }
  if(state.centerTab === "elements") renderElementsTab(content, toolbar);
  else renderRecipesTab(content, toolbar);
}

function renderElementsTab(content, toolbar){
  const {items, a} = getFilteredItems();
  toolbar.innerHTML = `
    <button class="tbtn primary" id="ct-add-element">＋ Add Element</button>
    <button class="tbtn" id="ct-bulk-edit">✎ Bulk Edit</button>
    <button class="tbtn danger" id="ct-bulk-delete">🗑 Bulk Delete</button>
    <button class="tbtn" id="ct-fill-all-recipes">⚡ Fill All Recipes</button>
    <div class="grow"></div>
    <span class="muted small">${items.length} of ${state.save.items.length} shown</span>
  `;
  toolbar.querySelector("#ct-add-element").onclick = addElement;
  toolbar.querySelector("#ct-bulk-edit").onclick = bulkEdit;
  toolbar.querySelector("#ct-bulk-delete").onclick = bulkDelete;
  toolbar.querySelector("#ct-fill-all-recipes").onclick = bulkFillAllRecipes;

  if(items.length===0){
    content.innerHTML = `<div class="empty-state"><div class="big">🔍</div><h3>No matches</h3><p>Try adjusting your search or filters.</p></div>`;
    return;
  }

  const dupIds = new Set(a.duplicates.map(x=>x.id));
  const deadIds = new Set(a.deadEnds.map(x=>x.id));
  const firstIds = new Set(a.firstDiscoveries.map(x=>x.id));
  const unreachIds = new Set(a.unreachable.map(x=>x.id));
  const customIds = new Set(a.customElements.map(x=>x.id));
  // Elements with no recipe that aren't base elements or first discoveries —
  // these are plausibly missing a recipe rather than legitimately having none.
  const lookupIds = customIds;
  const allSelected = items.length>0 && items.every(it=>state.selectedIds.has(it.id));

  content.innerHTML = `
    <div class="table-wrap" id="elem-scroll">
      <table class="elem-table">
        <thead><tr>
          <th class="checkbox-cell"><input type="checkbox" id="select-all-cb" aria-label="Select all elements" ${allSelected?'checked':''}></th>
          <th></th>
          <th data-sort="name" class="${state.sort.key==='name'?'sorted '+state.sort.dir:''}">Name</th>
          <th data-sort="id" class="${state.sort.key==='id'?'sorted '+state.sort.dir:''}">ID</th>
          <th data-sort="recipes" class="${state.sort.key==='recipes'?'sorted '+state.sort.dir:''}" style="text-align:right">Recipes</th>
          <th data-sort="used" class="${state.sort.key==='used'?'sorted '+state.sort.dir:''}" style="text-align:right">Used in</th>
          <th>Tags</th>
          <th style="text-align:right">Actions</th>
        </tr></thead>
        <tbody id="elem-tbody"></tbody>
      </table>
    </div>
  `;
  {
    const scrollEl = content.querySelector("#elem-scroll");
    const tbody = content.querySelector("#elem-tbody");
    const buildRow = (it)=>{
      const tags = [];
      if(firstIds.has(it.id)) tags.push('<span class="tag first">First</span>');
      if(dupIds.has(it.id)) tags.push('<span class="tag dup">Dup</span>');
      if(deadIds.has(it.id)) tags.push('<span class="tag dead">Dead end</span>');
      if(unreachIds.has(it.id)) tags.push('<span class="tag unreach">Unreachable</span>');
      if(customIds.has(it.id)) tags.push('<span class="tag custom">Custom</span>');
      if(lookupIds.has(it.id)) tags.push('<span class="tag norecipe">No recipe</span>');
      const isLookup = lookupIds.has(it.id);
      return `<tr data-id="${it.id}" class="${state.selectedId===it.id?'selected':''}${state.selectedIds.has(it.id)?' selected-bulk':''}">
        <td class="checkbox-cell"><input type="checkbox" class="row-cb" data-id="${it.id}" aria-label="Select ${escapeHtml(it.text)}" ${state.selectedIds.has(it.id)?'checked':''}></td>
        <td class="emoji-cell">${escapeHtml(it.emoji)}</td>
        <td class="name-cell">${escapeHtml(it.text)}</td>
        <td class="id-cell">#${it.id}</td>
        <td class="num-cell">${(it.recipes||[]).length}</td>
        <td class="num-cell">${a.ingredientUsage.get(it.id)||0}</td>
        <td class="tags-cell">${tags.join("")}</td>
        <td class="actions-cell">
          ${isLookup ? `<button class="icon-btn lookup" data-act="lookup" data-id="${it.id}" title="Search recipe on InfiniBrowser API">🔍</button>` : ""}
          <button class="icon-btn" data-act="edit" data-id="${it.id}" title="Edit (F2)">✎</button>
          <button class="icon-btn danger" data-act="delete" data-id="${it.id}" title="Delete">🗑</button>
        </td>
      </tr>`;
    };
    virtualizeRows(scrollEl, tbody, items, 36, buildRow, "tr");
  }

  // Delegated header sort
  const thead = content.querySelector("thead");
  if(thead) thead.addEventListener("click", (e)=>{
    const th = e.target.closest("th[data-sort]");
    if(!th) return;
    const key = th.dataset.sort;
    if(state.sort.key===key) state.sort.dir = state.sort.dir==="asc"?"desc":"asc";
    else { state.sort.key = key; state.sort.dir = "asc"; }
    renderCenter();
  });
  // Delegated tbody click / change (one listener each instead of ~N*4)
  const tbody = content.querySelector("tbody");
  if(tbody){
    tbody.addEventListener("click", async (e)=>{
      const btn = e.target.closest(".icon-btn");
      if(btn){
        e.stopPropagation();
        const id = parseInt(btn.dataset.id,10);
        const act = btn.dataset.act;
        if(act === "edit") return editElement(id);
        if(act === "delete") return deleteElement(id);
        if(act === "lookup"){
          const item = state.save.items.find(x=>x.id===id);
          if(!item) return;
          btn.disabled = true;
          btn.textContent = "⏳";
          toast(`Looking up recipe for ${item.text}…`);
          await autoImportRecipeFor(item.text);
          renderCenter();
        }
        return;
      }
      if(e.target.classList.contains("row-cb")) return; // handled by change
       const tr = e.target.closest("tr[data-id]");
       if(tr){
         const id = parseInt(tr.dataset.id,10);
         if(state.selectedId === id) selectElement(null);
         else selectElement(id);
       }
    });
    tbody.addEventListener("change", (e)=>{
      const cb = e.target.closest(".row-cb");
      if(!cb) return;
      const id = parseInt(cb.dataset.id,10);
      if(cb.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
      cb.closest("tr").classList.toggle("selected-bulk", cb.checked);
      syncSelectAllCheckbox();
    });
  }
  const selectAll = content.querySelector("#select-all-cb");
  const syncSelectAllCheckbox = ()=>{
    if(!selectAll) return;
    const allNowSelected = items.length>0 && items.every(it=>state.selectedIds.has(it.id));
    const someNowSelected = !allNowSelected && items.some(it=>state.selectedIds.has(it.id));
    selectAll.checked = allNowSelected;
    selectAll.indeterminate = someNowSelected;
  };
  syncSelectAllCheckbox();
  if(selectAll) selectAll.addEventListener("change", ()=>{
    if(selectAll.checked) items.forEach(it=>state.selectedIds.add(it.id));
    else items.forEach(it=>state.selectedIds.delete(it.id));
    renderCenter();
  });
}

function renderRecipesTab(content, toolbar){
  const byId = itemsById(state.save);
  const dupRecipes = findDuplicateRecipes(state.save);
  const dupKeySet = new Set();
  dupRecipes.forEach(d=>d.indices.forEach(i=>dupKeySet.add(d.itemId+":"+i)));

  toolbar.innerHTML = `
    <button class="tbtn primary" id="ct-add-recipe">＋ Add Recipe</button>
    ${state.recipeFilterElement!=null ? `<span class="chip active">Filtered: ${escapeHtml(byId.get(state.recipeFilterElement)?.text||'?')} <span style="margin-left:4px;cursor:pointer" id="clear-recipe-filter">✕</span></span>` : ""}
    ${dupRecipes.length ? `<span class="chip" style="border-color:var(--warn);color:var(--warn)">⚠ ${dupRecipes.length} duplicate recipe(s)</span>` : ""}
    <div class="grow"></div>
  `;
  toolbar.querySelector("#ct-add-recipe").onclick = ()=>addRecipe(state.recipeFilterElement);
  const clearBtn = toolbar.querySelector("#clear-recipe-filter");
  if(clearBtn) clearBtn.onclick = ()=>{ state.recipeFilterElement=null; renderCenter(); };

  let rows = [];
  for(const it of state.save.items){
    (it.recipes||[]).forEach((r, idx)=>{
      if(state.recipeFilterElement!=null && it.id!==state.recipeFilterElement && !r.includes(state.recipeFilterElement)) return;
      rows.push({result: it, idx, a: r[0], b: r[1], dup: dupKeySet.has(it.id+":"+idx)});
    });
  }
  const q = state.search.trim().toLowerCase();
  if(q){
    rows = rows.filter(row=>{
      const aItem = byId.get(row.a), bItem = byId.get(row.b);
      return row.result.text.toLowerCase().includes(q) ||
        (aItem && aItem.text.toLowerCase().includes(q)) ||
        (bItem && bItem.text.toLowerCase().includes(q));
    });
  }

  if(rows.length===0){
    content.innerHTML = `<div class="empty-state"><div class="big">🧬</div><h3>No recipes</h3><p>No recipes match the current filters.</p></div>`;
    return;
  }

  content.innerHTML = `<div class="recipe-table-wrap" id="recipe-scroll"><div id="recipe-body"></div></div>`;
  {
    const scrollEl = content.querySelector("#recipe-scroll");
    const body = content.querySelector("#recipe-body");
    const buildRow = (row)=>{
      const aItem = byId.get(row.a), bItem = byId.get(row.b);
      return `<div class="recipe-row ${row.dup?'dup-recipe':''}" data-result="${row.result.id}" data-idx="${row.idx}" style="${row.dup?'background:rgba(224,181,88,0.06)':''}">
        <span class="id-badge">#${row.result.id}</span>
        <span class="ing">${aItem?`<span class="em">${escapeHtml(aItem.emoji)}</span> ${escapeHtml(aItem.text)}`:`<span style="color:var(--danger)">Missing #${row.a}</span>`}</span>
        <span class="plus">+</span>
        <span class="ing">${bItem?`<span class="em">${escapeHtml(bItem.emoji)}</span> ${escapeHtml(bItem.text)}`:`<span style="color:var(--danger)">Missing #${row.b}</span>`}</span>
        <span class="result">→ <span class="em">${escapeHtml(row.result.emoji)}</span> ${escapeHtml(row.result.text)} ${row.dup?'<span class="tag dup">Dup</span>':''}</span>
      </div>`;
    };
    virtualizeRows(scrollEl, body, rows, 36, buildRow, "div");
  }
  const _rtWrap = content.querySelector("#recipe-scroll");
  if(_rtWrap) _rtWrap.addEventListener("click", (e)=>{
    const row = e.target.closest(".recipe-row");
    if(!row) return;
    editRecipe(parseInt(row.dataset.result,10), parseInt(row.dataset.idx,10));
  });
}

/* =========================================================================
   RENDER: RIGHT SIDEBAR (inspector + dep tree)
   ========================================================================= */
function selectElement(id){
  state.selectedId = id;
  state.recipeFilterElement = id;
  renderCenter();
  renderInspector();
  if(id != null) highlightGraphNode(id);
}

function buildDepTree(id, byId, direction, depth, visited){
  // direction: 'forward' = ingredients used to make this; 'reverse' = things this is used in
  visited = visited || new Set();
  if(depth > 8 || visited.has(id)) return null;
  visited = new Set(visited); visited.add(id);
  const item = byId.get(id);
  if(!item) return {id, missing:true, children:[]};
  let childIds = [];
  if(direction==="forward"){
    const recipe = (item.recipes||[])[0];
    childIds = recipe ? recipe : [];
  } else {
    childIds = [];
    for(const other of state.save.items){
      if((other.recipes||[]).some(r=>r.includes(id))) childIds.push(other.id);
    }
  }
  return {
    id, item,
    children: childIds.map(cid=>buildDepTree(cid, byId, direction, depth+1, visited)).filter(Boolean)
  };
}

function renderDepNode(node, byId){
  if(!node) return "";
  if(node.missing) return `<div class="dep-node"><span class="em">⚠</span><span class="nm" style="color:var(--danger)">Missing #${node.id}</span></div>`;
  const hasChildren = node.children && node.children.length>0;
  return `<div>
    <div class="dep-node" data-goto="${node.id}">
      <span class="em">${escapeHtml(node.item.emoji)}</span>
      <span class="nm">${escapeHtml(node.item.text)}</span>
      <span class="muted small">#${node.id}</span>
    </div>
    ${hasChildren ? `<div class="dep-children">${node.children.map(c=>renderDepNode(c, byId)).join("")}</div>` : ""}
  </div>`;
}

function renderInspector(){
  const body = document.getElementById("inspector-body");
  if(!state.save || state.selectedId==null){
    body.innerHTML = `<div class="inspector-empty">Select an element to inspect it.</div>`;
    return;
  }
  const a = analyze(state.save);
  const it = a.byId.get(state.selectedId);
  if(!it){
    body.innerHTML = `<div class="inspector-empty">Element not found (it may have been deleted).</div>`;
    return;
  }
  const tags = [];
  if(it.discovery === 1 || BASE_ELEMENT_NAMES.has(it.text)) tags.push('<span class="tag first">First discovery</span>');
  if(a.duplicates.some(d=>d.id===it.id)) tags.push('<span class="tag dup">Duplicate</span>');
  if(a.deadEnds.some(d=>d.id===it.id)) tags.push('<span class="tag dead">Dead end</span>');
  if(a.unreachable.some(d=>d.id===it.id)) tags.push('<span class="tag unreach">Unreachable</span>');
  if(a.customElements.some(d=>d.id===it.id)) tags.push('<span class="tag custom">Custom</span>');

  const usedCount = a.ingredientUsage.get(it.id)||0;
  const forwardTree = buildDepTree(it.id, a.byId, "forward", 0);
  const reverseChildren = [];
  for(const other of state.save.items){
    if((other.recipes||[]).some(r=>r.includes(it.id))) reverseChildren.push(other.id);
  }

  body.innerHTML = `
    <div class="inspector-head">
      <div class="inspector-emoji">${escapeHtml(it.emoji)}</div>
      <div>
        <div class="inspector-name">${escapeHtml(it.text)}</div>
        <div class="inspector-id">ID #${it.id}</div>
        <div class="inspector-tags">${tags.join("") || '<span class="muted small">No flags</span>'}</div>
      </div>
    </div>
    <div class="flex gap8" style="margin-bottom:14px;">
      <button class="tbtn" id="insp-edit">✎ Edit</button>
      <button class="tbtn" id="insp-add-recipe">＋ Recipe</button>
      <button class="tbtn danger" id="insp-delete">🗑 Delete</button>
    </div>

    <div class="stat-grid" style="margin-bottom:14px;">
      <div class="stat-card"><div class="num">${(it.recipes||[]).length}</div><div class="lbl">Recipes to make this</div></div>
      <div class="stat-card"><div class="num">${usedCount}</div><div class="lbl">Used as ingredient</div></div>
    </div>

    <div class="section" data-section="dep-fwd">
      <div class="section-title"><span class="chev">▾</span> Dependency tree (ingredients)</div>
      <div class="section-content dep-tree">
        ${forwardTree && forwardTree.children.length ? renderDepNode(forwardTree, a.byId) : '<div class="muted small">This is a base element with no recipe.</div>'}
        ${(it.recipes||[]).length>1 ? `<div class="muted small" style="margin-top:6px;">+ ${it.recipes.length-1} more recipe(s) — see Recipes tab.</div>` : ""}
      </div>
    </div>

    <div class="section" data-section="dep-rev">
      <div class="section-title"><span class="chev">▾</span> Used to make (reverse deps)</div>
      <div class="section-content dep-tree">
        ${reverseChildren.length ? reverseChildren.map(cid=>{
          const citem = a.byId.get(cid);
          return `<div class="dep-node" data-goto="${cid}"><span class="em">${escapeHtml(citem.emoji)}</span><span class="nm">${escapeHtml(citem.text)}</span><span class="muted small">#${cid}</span></div>`;
        }).join("") : '<div class="muted small">Not used in any recipe (dead end).</div>'}
      </div>
    </div>

    <div class="section" data-section="uses-live">
      <div class="section-title"><span class="chev">▾</span> Used in (live InfiniBrowser lookup)</div>
      <div class="section-content" id="insp-uses-body">${renderUsesSectionBody(it.id, it.text, it.emoji)}</div>
    </div>
  `;
  body.querySelector("#insp-edit").onclick = ()=>editElement(it.id);
  body.querySelector("#insp-add-recipe").onclick = ()=>addRecipe(it.id);
  body.querySelector("#insp-delete").onclick = ()=>deleteElement(it.id);
  body.querySelectorAll("[data-goto]").forEach(n=>{
    n.addEventListener("click", ()=>selectElement(parseInt(n.dataset.goto,10)));
  });
  body.querySelectorAll(".section-title").forEach(t=>{
    t.addEventListener("click", ()=>t.closest(".section").classList.toggle("collapsed"));
  });
  wireUsesSection(it.id, it.text, it.emoji);
}

/* =========================================================================
   GRAPH VIEW (Canvas-free, pure SVG)
   ========================================================================= */
const svg = document.getElementById("graph-svg");
const viewport = document.getElementById("graph-viewport");
const edgesG = document.getElementById("graph-edges");
const nodesG = document.getElementById("graph-nodes");

function initGraphLayout(){
  const g = state.graph;
  g.nodes.clear();
  if(!state.save) return;
  const n = state.save.items.length;
  const cols = Math.ceil(Math.sqrt(n*2.2));
  state.save.items.forEach((it, i)=>{
    const angle = (i / n) * Math.PI * 2 * 3; // spiral-ish spread
    const ring = Math.floor(i / cols);
    const col = i % cols;
    const spacing = 90;
    g.nodes.set(it.id, {
      x: col*spacing + (ring%2===0?0:spacing/2) + Math.random()*10,
      y: ring*spacing + Math.random()*10
    });
  });
  // run a light force simulation to declutter
  runForceLayout(60);
  // defer getBoundingClientRect until after paint to avoid forced reflow causing CLS
  requestAnimationFrame(()=>requestAnimationFrame(()=>fitGraphToView()));
}

function runForceLayout(iterations){
  if(!state.save) return;
  const g = state.graph;
  const nodes = [...g.nodes.entries()];
  const idToIdx = new Map(nodes.map(([id],i)=>[id,i]));
  const edges = [];
  for(const it of state.save.items){
    for(const r of (it.recipes||[])){
      for(const ing of r){
        if(g.nodes.has(ing)) edges.push([ing, it.id]);
      }
    }
  }
  for(let iter=0; iter<iterations; iter++){
    // repulsion
    for(let i=0;i<nodes.length;i++){
      for(let j=i+1;j<nodes.length;j++){
        const [, pi] = nodes[i], [, pj] = nodes[j];
        let dx = pi.x-pj.x, dy = pi.y-pj.y;
        let distSq = dx*dx+dy*dy;
        if(distSq < 1) distSq = 1;
        const dist = Math.sqrt(distSq);
        if(dist < 140){
          const force = (140-dist)/dist * 0.6;
          const fx = dx*force, fy = dy*force;
          pi.x += fx*0.5; pi.y += fy*0.5;
          pj.x -= fx*0.5; pj.y -= fy*0.5;
        }
      }
    }
    // attraction along edges
    for(const [a,b] of edges){
      const pa = g.nodes.get(a), pb = g.nodes.get(b);
      if(!pa || !pb) continue;
      const dx = pb.x-pa.x, dy = pb.y-pa.y;
      const dist = Math.sqrt(dx*dx+dy*dy)||1;
      const targetDist = 95;
      const force = (dist-targetDist)/dist * 0.04;
      pa.x += dx*force; pa.y += dy*force;
      pb.x -= dx*force; pb.y -= dy*force;
    }
  }
}

function fitGraphToView(){
  const g = state.graph;
  if(g.nodes.size===0) return;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const [,p] of g.nodes){
    minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x);
    minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y);
  }
  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
  const contentW = Math.max(1, maxX-minX+120);
  const contentH = Math.max(1, maxY-minY+120);
  const scale = Math.min(w/contentW, h/contentH, 2.5);
  g.zoom = scale;
  g.panX = w/2 - ((minX+maxX)/2)*scale;
  g.panY = h/2 - ((minY+maxY)/2)*scale;
  applyGraphTransform();
}

function applyGraphTransform(){
  const g = state.graph;
  viewport.setAttribute("transform", `translate(${g.panX},${g.panY}) scale(${g.zoom})`);
}

function renderGraph(){
  if(!state.save){
    edgesG.innerHTML = ""; nodesG.innerHTML = "";
    document.getElementById("graph-status").textContent = "No data";
    return;
  }
  const g = state.graph;
  document.getElementById("graph-status").textContent = `${state.save.items.length} nodes · ${state.save.items.reduce((s,it)=>s+(it.recipes||[]).length,0)} edges · zoom ${g.zoom.toFixed(2)}x`;

  const byId = itemsById(state.save);
  let edgesHtml = "";
  const edgeList = [];
  for(const it of state.save.items){
    for(const r of (it.recipes||[])){
      for(const ing of r){
        const p1 = g.nodes.get(ing), p2 = g.nodes.get(it.id);
        if(!p1 || !p2) continue;
        edgeList.push({from:ing, to:it.id, p1, p2});
      }
    }
  }

  // highlight sets
  let fwdSet = new Set(), revSet = new Set();
  if(g.selected != null){
    fwdSet.add(g.selected); revSet.add(g.selected);
    const item = byId.get(g.selected);
    if(item){
      for(const r of (item.recipes||[])) for(const ing of r) fwdSet.add(ing);
    }
    for(const other of state.save.items){
      if((other.recipes||[]).some(r=>r.includes(g.selected))) revSet.add(other.id);
    }
  }
  const anyHighlight = g.selected != null;

  edgesHtml = edgeList.map(e=>{
    let cls = "graph-edge";
    if(anyHighlight){
      if(e.to === g.selected && fwdSet.has(e.from)) cls += " hl-fwd";
      else if(e.from === g.selected && revSet.has(e.to)) cls += " hl-rev";
      else cls += " dimmed";
    }
    return `<path class="${cls}" d="M${e.p1.x},${e.p1.y} L${e.p2.x},${e.p2.y}"></path>`;
  }).join("");
  edgesG.innerHTML = edgesHtml;

  let nodesHtml = "";
  for(const it of state.save.items){
    const p = g.nodes.get(it.id);
    if(!p) continue;
    let cls = "graph-node-circle";
    if(state.selectedId === it.id || g.selected===it.id) cls += " selected";
    else if(anyHighlight && fwdSet.has(it.id)) cls += " hl-fwd";
    else if(anyHighlight && revSet.has(it.id)) cls += " hl-rev";
    else if(anyHighlight) cls += " dimmed";

    let labelCls = "graph-label" + (anyHighlight && !fwdSet.has(it.id) && !revSet.has(it.id) ? " dimmed" : "");

    nodesHtml += `<g class="graph-node" data-id="${it.id}" transform="translate(${p.x},${p.y})">
      <circle class="${cls}" r="16"></circle>
      ${g.showEmoji ? `<text class="graph-emoji" y="1">${escapeHtml(it.emoji)}</text>` : ""}
      ${g.showLabels ? `<text class="${labelCls}" x="20" y="4">${escapeHtml(it.text)}</text>` : ""}
    </g>`;
  }
  nodesG.innerHTML = nodesHtml;

  nodesG.querySelectorAll(".graph-node").forEach(nodeEl=>{
    nodeEl.addEventListener("pointerdown", (e)=>{
      if(e.pointerType==="touch" && activePointers.size>=1) return; // let pinch take over
      e.stopPropagation();
      g.dragNode = parseInt(nodeEl.dataset.id,10);
    });
    nodeEl.addEventListener("click", (e)=>{
      e.stopPropagation();
      const id = parseInt(nodeEl.dataset.id,10);
      g.selected = id;
      selectElement(id);
    });
  });
}

function highlightGraphNode(id){
  state.graph.selected = id;
  renderGraph();
}

function centerOnNode(id){
  const g = state.graph;
  const p = g.nodes.get(id);
  if(!p) return;
  const rect = svg.getBoundingClientRect();
  g.panX = rect.width/2 - p.x*g.zoom;
  g.panY = rect.height/2 - p.y*g.zoom;
  applyGraphTransform();
}

// pan/zoom/drag interactions — unified pointer events (mouse, touch, pen)
// supports single-pointer pan/drag and two-finger pinch-to-zoom.
const activePointers = new Map(); // pointerId -> {x,y}
let pinchStartDist = null, pinchStartZoom = null, pinchStartMid = null;

function pointerDist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function pointerMid(a,b){ return {x:(a.x+b.x)/2, y:(a.y+b.y)/2}; }

svg.addEventListener("pointerdown", (e)=>{
  svg.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(activePointers.size === 2){
    // start pinch — cancel any single-pointer pan/drag in progress
    state.graph.panning = false;
    state.graph.dragNode = null;
    svg.classList.remove("panning");
    const pts = [...activePointers.values()];
    pinchStartDist = pointerDist(pts[0], pts[1]);
    pinchStartZoom = state.graph.zoom;
    pinchStartMid = pointerMid(pts[0], pts[1]);
    return;
  }
  if(state.graph.dragNode != null) return;
  state.graph.panning = true;
  state.graph.lastMouse = {x:e.clientX, y:e.clientY};
  svg.classList.add("panning");
});
window.addEventListener("pointermove", (e)=>{
  if(!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  const g = state.graph;

  if(activePointers.size === 2 && pinchStartDist){
    const pts = [...activePointers.values()];
    const dist = pointerDist(pts[0], pts[1]);
    const rect = svg.getBoundingClientRect();
    const mid = pointerMid(pts[0], pts[1]);
    const worldX = (pinchStartMid.x-rect.left-g.panX)/pinchStartZoom;
    const worldY = (pinchStartMid.y-rect.top-g.panY)/pinchStartZoom;
    g.zoom = Math.max(0.05, Math.min(8, pinchStartZoom * (dist/pinchStartDist)));
    g.panX = (mid.x-rect.left) - worldX*g.zoom;
    g.panY = (mid.y-rect.top) - worldY*g.zoom;
    applyGraphTransform();
    return;
  }

  if(g.dragNode != null){
    const rect = svg.getBoundingClientRect();
    const localX = (e.clientX - rect.left - g.panX)/g.zoom;
    const localY = (e.clientY - rect.top - g.panY)/g.zoom;
    g.nodes.set(g.dragNode, {x:localX, y:localY});
    renderGraph();
    return;
  }
  if(g.panning && g.lastMouse){
    const dx = e.clientX - g.lastMouse.x;
    const dy = e.clientY - g.lastMouse.y;
    g.panX += dx; g.panY += dy;
    g.lastMouse = {x:e.clientX, y:e.clientY};
    applyGraphTransform();
  }
});
function endGraphPointer(e){
  activePointers.delete(e.pointerId);
  if(activePointers.size < 2){ pinchStartDist = null; }
  if(activePointers.size === 0){
    state.graph.panning = false;
    state.graph.dragNode = null;
    svg.classList.remove("panning");
  }
}
window.addEventListener("pointerup", endGraphPointer);
window.addEventListener("pointercancel", endGraphPointer);
svg.addEventListener("wheel", (e)=>{
  e.preventDefault();
  const g = state.graph;
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX-rect.left, my = e.clientY-rect.top;
  const worldX = (mx-g.panX)/g.zoom, worldY = (my-g.panY)/g.zoom;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  g.zoom = Math.max(0.05, Math.min(8, g.zoom*delta));
  g.panX = mx - worldX*g.zoom;
  g.panY = my - worldY*g.zoom;
  applyGraphTransform();
}, {passive:false});

function animatedGraphAction(fn){
  viewport.classList.add("animated");
  fn();
  setTimeout(()=>viewport.classList.remove("animated"), 300);
}
document.getElementById("graph-zoom-in").onclick = ()=>{
  animatedGraphAction(()=>{ const g = state.graph; g.zoom = Math.min(8, g.zoom*1.25); applyGraphTransform(); });
};
document.getElementById("graph-zoom-out").onclick = ()=>{
  animatedGraphAction(()=>{ const g = state.graph; g.zoom = Math.max(0.05, g.zoom*0.8); applyGraphTransform(); });
};
document.getElementById("graph-reset").onclick = ()=>animatedGraphAction(fitGraphToView);
document.getElementById("graph-center").onclick = ()=>{
  if(state.selectedId!=null) animatedGraphAction(()=>centerOnNode(state.selectedId));
};
document.getElementById("graph-toggle-labels").onclick = (e)=>{
  state.graph.showLabels = !state.graph.showLabels;
  e.target.style.color = state.graph.showLabels ? "var(--accent)" : "";
  renderGraph();
};
document.getElementById("graph-toggle-emoji").onclick = (e)=>{
  state.graph.showEmoji = !state.graph.showEmoji;
  e.target.style.color = state.graph.showEmoji ? "var(--accent)" : "";
  renderGraph();
};
document.getElementById("graph-relayout").onclick = ()=>{
  runForceLayout(80);
  renderGraph();
};

/* =========================================================================
   API LOOKUP: Fetch recipes from infinibrowser.wiki
   ========================================================================= */
async function fetchInfiniBrowserSteps(name){
  const proxyUrl = `https://cors.qikseek.qzz.io/?url=${encodeURIComponent(`https://infinibrowser.wiki/api/Recipe?id=${encodeURIComponent(name)}`)}`;
  const resp = await fetch(proxyUrl);
  if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const wrapper = await resp.json();
  // cors.qikseek wraps response in {contents: "..."}
  return wrapper.contents ? JSON.parse(wrapper.contents) : wrapper;
}

/* -------------------------------------------------------------------------
   LIVE "USED IN" LOOKUP: what other InfiniBrowser recipes use this element
   as an ingredient. /api/uses/?id=X&offset=N uses a sliding-window offset
   (not a page number) — each increment can reveal one new entry while
   dropping the oldest, and can also repeat entries already seen — so we
   accumulate into a de-duped map keyed by pair+result rather than trusting
   the raw page contents. Cached per element id, per inspector session
   (not persisted to the save file).
   ------------------------------------------------------------------------- */
const liveUsesCache = new Map(); // id -> {items:[], seenKeys:Set, offset:0, total:null, loading:false, error:null}

async function fetchInfiniBrowserUses(name, offset){
  const proxyUrl = `https://cors.qikseek.qzz.io/?url=${encodeURIComponent(`https://infinibrowser.wiki/api/uses/?id=${encodeURIComponent(name)}&offset=${offset}`)}`;
  const resp = await fetch(proxyUrl);
  if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const wrapper = await resp.json();
  return wrapper.contents ? JSON.parse(wrapper.contents) : wrapper;
}

function renderUsesSectionBody(id, name, emoji){
  const c = liveUsesCache.get(id);
  if(!c){
    return `<button class="tbtn" id="uses-fetch-btn" style="width:100%;">🌐 Fetch live uses from InfiniBrowser</button>
      <div class="small muted" style="margin-top:6px;">⚠️ Uses infinibrowser.wiki's undocumented API. It's not guaranteed to be stable.</div>`;
  }
  if(c.error){
    return `<div class="small" style="color:var(--danger);margin-bottom:8px;">Error: ${escapeHtml(c.error)}<br><br><span class="small muted">Proxy might be down or element doesn't exist on InfiniBrowser.</span></div>
      <button class="tbtn" id="uses-fetch-btn" style="width:100%;">🔁 Retry</button>`;
  }
  const listHtml = c.items.length
    ? `<div class="small muted" style="margin-bottom:6px;">Each row shows this element + the other ingredient InfiniBrowser paired it with — not a full recipe by itself.</div>
      <div class="stat-list" style="margin-bottom:8px;">${c.items.map(u=>`
        <div class="stat-list-row" style="border-top:1px dashed var(--border);padding-top:5px;margin-top:5px;">
          <span class="k">${escapeHtml(emoji||"")} ${escapeHtml(name||"?")} <span style="color:var(--text-2);">+</span> ${escapeHtml(u.pair?.emoji||"")} ${escapeHtml(u.pair?.id||"?")}</span>
          <span style="color:var(--text-2);">→</span>
          <span class="k" style="color:var(--accent)">${escapeHtml(u.result?.emoji||"")} ${escapeHtml(u.result?.id||"?")}</span>
        </div>
      `).join("")}</div>`
    : `<div class="small muted" style="margin-bottom:8px;">No uses found${c.total!=null?` (total ${c.total})`:""}.</div>`;
  const done = c.total!=null && c.items.length >= c.total;
  const loadMoreHtml = c.loading
    ? `<div class="small muted">Loading…</div>`
    : (done
        ? `<div class="small muted">All ${c.total} use(s) loaded.</div>`
        : `<button class="tbtn" id="uses-loadmore-btn" style="width:100%;">Load more${c.total!=null?` (${c.items.length} / ${c.total})`:""}</button>`);
  return listHtml + loadMoreHtml;
}

function wireUsesSection(id, name, emoji){
  const container = document.getElementById("insp-uses-body");
  if(!container) return;
  const fetchBtn = container.querySelector("#uses-fetch-btn");
  if(fetchBtn) fetchBtn.onclick = ()=>loadMoreUses(id, name, emoji);
  const moreBtn = container.querySelector("#uses-loadmore-btn");
  if(moreBtn) moreBtn.onclick = ()=>loadMoreUses(id, name, emoji);
}

async function loadMoreUses(id, name, emoji){
  let c = liveUsesCache.get(id);
  if(!c){
    c = {items:[], seenKeys:new Set(), offset:0, total:null, loading:false, error:null};
    liveUsesCache.set(id, c);
  }
  c.loading = true; c.error = null;
  const container = document.getElementById("insp-uses-body");
  if(container){ container.innerHTML = renderUsesSectionBody(id, name, emoji); wireUsesSection(id, name, emoji); }
  try{
    const data = await fetchInfiniBrowserUses(name, c.offset);
    if(typeof data.total === "number") c.total = data.total;
    for(const u of (data.uses||[])){
      const key = `${u.pair?.id}::${u.result?.id}`;
      if(!c.seenKeys.has(key)){
        c.seenKeys.add(key);
        c.items.push(u);
      }
    }
    c.offset += 1;
  }catch(err){
    console.error("InfiniBrowser uses lookup error:", err);
    c.error = err.message;
  }finally{
    c.loading = false;
    const container2 = document.getElementById("insp-uses-body");
    if(container2){ container2.innerHTML = renderUsesSectionBody(id, name, emoji); wireUsesSection(id, name, emoji); }
  }
}

// Used by the "Auto-fetch recipe" toggle on Add Element: looks up and applies
// the recipe chain immediately, without the manual preview/confirm step.
async function autoImportRecipeFor(name){
  try{
    const data = await fetchInfiniBrowserSteps(name);
    if(!data.steps || data.steps.length===0){
      toast(`No InfiniBrowser recipe found for ${name}`, "error");
      return;
    }
    const plan = planApiRecipeImport(data.steps);
    applyApiRecipeImport(plan);
    toast(`Auto-imported ${plan.recipeActions.length} recipe(s) for ${name}`, "success");
  }catch(err){
    console.error("Auto recipe import error:", err);
    toast(`Couldn't fetch recipe for ${name}: ${err.message}`, "error");
  }
}

// Runs the InfiniBrowser lookup across every element currently missing a
// recipe, one at a time with a short delay between calls, showing progress
// in a modal. Skips base elements and first discoveries (see lookupIds).
async function bulkFillAllRecipes(){
  if(!state.save) return;
  const a = analyze(state.save);
  const targets = a.customElements.slice(); // {id, text, ...} snapshot
  if(targets.length===0){ toast("No elements are missing a recipe", "success"); return; }

  let cancelled = false;
  let done = 0;
  let okCount = 0, failCount = 0;

  openModal({
    title: `Filling ${targets.length} Recipe(s)`,
    bodyHtml: `
      <div class="bulkfill-count"><span id="bf-status">Starting…</span><span id="bf-fraction">0 / ${targets.length}</span></div>
      <div class="bulkfill-bar-track"><div class="bulkfill-bar-fill" id="bf-bar" style="width:0%"></div></div>
      <div class="bulkfill-log" id="bf-log"></div>
    `,
    footerButtons: [
      {label:"Cancel", onClick: ()=>{ cancelled = true; closeModal(); }}
    ],
    onMount: async (overlay)=>{
      const statusEl = overlay.querySelector("#bf-status");
      const fracEl = overlay.querySelector("#bf-fraction");
      const barEl = overlay.querySelector("#bf-bar");
      const logEl = overlay.querySelector("#bf-log");

      for(const target of targets){
        if(cancelled) return;
        const item = state.save.items.find(x=>x.id===target.id);
        if(!item || (item.recipes && item.recipes.length>0)){ done++; continue; } // already resolved this run
        statusEl.textContent = `Looking up ${item.text}…`;
        let ok = false;
        try{
          const data = await fetchInfiniBrowserSteps(item.text);
          if(data.steps && data.steps.length>0){
            const plan = planApiRecipeImport(data.steps);
            applyApiRecipeImport(plan);
            ok = true;
          }
        }catch(err){
          console.error("Bulk fill error for", item.text, err);
        }
        if(cancelled) return;
        done++;
        if(ok) okCount++; else failCount++;
        const row = document.createElement("div");
        row.className = "bulkfill-log-row " + (ok?"ok":"fail");
        row.innerHTML = `<span class="ic">${ok?"✓":"✕"}</span><span class="name">${escapeHtml(item.text)}</span>`;
        logEl.prepend(row);
        fracEl.textContent = `${done} / ${targets.length}`;
        barEl.style.width = Math.round((done/targets.length)*100)+"%";
        await new Promise(r=>setTimeout(r, 550)); // be gentle with the lookup proxy
      }
      if(cancelled) return;
      statusEl.textContent = "Done";
      renderCenter();
      toast(`Filled ${okCount} recipe(s)${failCount?`, ${failCount} not found`:""}`, okCount?"success":"error");
      setTimeout(()=>{ if(document.getElementById("active-modal-overlay")) closeModal(); }, 900);
    }
  });
}

/* =========================================================================
   INFINIBROWSER SEARCH: plain HTTP GET to the search API, used to power the
   suggestion/autofill dropdowns on API Lookup and Add Element.
   ========================================================================= */

// Simple fetch-based lookup. Response shape:
// {"query":"poop","offset":0,"count":4,"items":[{"id":"Poop","emoji":"💩"},...]}
async function searchInfiniBrowser(query, limit=5){
  if(!query || !query.trim()) return [];
  try{
    const url = `https://infinibrowser-ws-test.vercel.app/api/search?id=${encodeURIComponent(query.trim())}`;
    const res = await fetch(url);
    if(!res.ok){
      console.warn("[InfiniBrowser] search request failed:", res.status);
      return [];
    }
    const data = await res.json();
    const items = (data && data.items) || [];
    return items.slice(0, limit);
  }catch(err){
    console.error("[InfiniBrowser] search failed:", err);
    return [];
  }
}

// Wires a text input to a dropdown of live InfiniBrowser suggestions
// (debounced, top `limit` results). onSelect(name, emoji) fires on click.
function wireInfiniBrowserAutocomplete(inputEl, resultsEl, onSelect, limit=5){
  let debounceTimer = null;
  let latestReq = 0;
  function hide(){ resultsEl.style.display = "none"; }
  function renderList(items){
    if(!items.length){
      resultsEl.innerHTML = '<div class="opt muted" style="cursor:default;">No matches</div>';
      resultsEl.style.display = "block";
      return;
    }
    resultsEl.innerHTML = items.map(it=>
      `<div class="opt" data-name="${escapeAttr(it.text||it.id)}" data-emoji="${escapeAttr(it.emoji||"")}"><span class="em">${escapeHtml(it.emoji||"")}</span><span>${escapeHtml(it.text||it.id)}</span></div>`
    ).join("");
    resultsEl.style.display = "block";
    resultsEl.querySelectorAll(".opt").forEach(opt=>{
      opt.onclick = ()=>{
        hide();
        onSelect(opt.dataset.name, opt.dataset.emoji);
      };
    });
  }
  inputEl.addEventListener("input", ()=>{
    const q = inputEl.value.trim();
    clearTimeout(debounceTimer);
    if(!q){ hide(); return; }
    resultsEl.innerHTML = '<div class="opt muted" style="cursor:default;">Searching…</div>';
    resultsEl.style.display = "block";
    debounceTimer = setTimeout(async ()=>{
      const reqId = ++latestReq;
      try{
        const items = await searchInfiniBrowser(q, limit);
        if(reqId !== latestReq) return; // a newer keystroke superseded this request
        renderList(items);
      }catch(err){
        if(reqId !== latestReq) return;
        console.error("[InfiniBrowser] autocomplete failed:", err);
        resultsEl.innerHTML = `<div class="opt muted" style="cursor:default;">Couldn't reach InfiniBrowser (see console)</div>`;
        resultsEl.style.display = "block";
      }
    }, 250);
  });
  inputEl.addEventListener("focus", ()=>{
    if(inputEl.value.trim() && resultsEl.innerHTML) resultsEl.style.display = "block";
  });
  document.addEventListener("click", (e)=>{
    if(!resultsEl.contains(e.target) && e.target!==inputEl) hide();
  });
}

async function openApiLookupModal(){
  openModal({
    title: "Look Up Element on InfiniBrowser",
    bodyHtml: `
      <p class="small muted">⚠️ This uses infinibrowser.wiki's undocumented API. It's not guaranteed to be stable.</p>
      <label class="field-label">Element name</label>
      <div class="ingredient-picker">
        <input class="field-input" id="api-lookup-input" placeholder="e.g. Geyser, Volcano, Lava" autocomplete="off">
        <div class="ingredient-results" id="api-lookup-suggest" style="display:none;"></div>
      </div>
      <div id="api-lookup-result" style="margin-top:14px;"></div>
    `,
    footerButtons: [
      {label:"Close", onClick: closeModal}
    ],
    onMount: (overlay)=>{
      const input = overlay.querySelector("#api-lookup-input");
      const suggest = overlay.querySelector("#api-lookup-suggest");
      input.focus();
      input.addEventListener("keyup", async (e)=>{
        if(e.key !== "Enter") return;
        suggest.style.display = "none";
        await performApiLookup(input.value.trim(), overlay);
      });
      wireInfiniBrowserAutocomplete(input, suggest, (name)=>{
        input.value = name;
        performApiLookup(name, overlay);
      });
    }
  });
}

async function performApiLookup(name, overlay){
  const resultArea = overlay.querySelector("#api-lookup-result");
  if(!name){ resultArea.innerHTML = '<div class="small muted">Type an element name and press Enter.</div>'; return; }
  resultArea.innerHTML = '<div class="small muted">Fetching...</div>';
  if(!state.save){
    resultArea.innerHTML = '<div class="small" style="color:var(--danger);">⚠️ Open or create a save file first before importing recipes.</div>';
    return;
  }
  try{
    const data = await fetchInfiniBrowserSteps(name);
    if(!data.steps || data.steps.length===0){
      resultArea.innerHTML = '<div class="small muted">No recipe found for that element.</div>';
      return;
    }
    displayApiRecipePreview(data, overlay);
  }catch(err){
    console.error('API error:', err);
    resultArea.innerHTML = `<div class="small" style="color:var(--danger);">Error: ${err.message}<br><br><span class="small muted">Proxy might be down or element doesn't exist.</span></div>`;
  }
}

function displayApiRecipePreview(data, overlay){
  const resultArea = overlay.querySelector("#api-lookup-result");
  const {steps, missing} = data;
  const plan = planApiRecipeImport(steps);
  
  resultArea.innerHTML = `
    <div class="stat-grid" style="margin-bottom:12px;">
      <div class="stat-card"><div class="num">${plan.newElements.length}</div><div class="lbl">New elements</div></div>
      <div class="stat-card"><div class="num">${plan.recipeActions.length}</div><div class="lbl">Recipes to add</div></div>
      <div class="stat-card ${plan.dupSkipped.length?'warn':''}"><div class="num">${plan.dupSkipped.length}</div><div class="lbl">Already exist</div></div>
    </div>
    ${plan.newElements.length ? `
      <div class="small" style="margin-bottom:4px;font-weight:700;color:var(--text-1);">New elements</div>
      <div class="stat-list" style="margin-bottom:12px;">
        ${plan.newElements.map(ne=>`<div class="stat-list-row"><span class="k">${escapeHtml(ne.emoji)} ${escapeHtml(ne.text)}</span><span class="v muted">new</span></div>`).join("")}
      </div>` : ""}
    <div class="small" style="margin-bottom:4px;font-weight:700;color:var(--text-1);">Recipe chain</div>
    <div class="stat-list" style="margin-bottom:12px;max-height:200px;overflow-y:auto;">
      ${steps.map((step,i)=>`
        <div class="stat-list-row" style="font-size:11.5px;">
          <span class="k">${escapeHtml(step.a.emoji)} ${escapeHtml(step.a.id)}</span>
          <span style="color:var(--text-2);">+</span>
          <span class="k">${escapeHtml(step.b.emoji)} ${escapeHtml(step.b.id)}</span>
          <span style="color:var(--text-2);">→</span>
          <span class="k" style="color:var(--accent)">${escapeHtml(step.result.emoji)} ${escapeHtml(step.result.id)}</span>
        </div>
      `).join("")}
    </div>
    <button class="tbtn primary" id="api-import-btn" style="width:100%;margin-top:8px;">Import all recipes</button>
  `;
  overlay.querySelector("#api-import-btn").onclick = ()=>{
    applyApiRecipeImport(plan);
    closeModal();
    toast(`Imported ${plan.recipeActions.length} recipe(s) from InfiniBrowser`, "success");
  };
}

/* =========================================================================
   OPEN SAVE MODAL — drag-and-drop zone + how-to tutorial
   ========================================================================= */
function openSaveModal(){
  const tutStepsWindows = `
    <div class="tut-step"><div class="num">1</div><div class="body"><strong>Open Infinite Craft</strong><span>Go to <code>neal.fun/infinite-craft</code> in your browser.</span></div></div>
    <div class="tut-step"><div class="num">2</div><div class="body"><strong>Open the Menu</strong><span>Click the <strong>☰ Menu</strong> button in the top-left corner of the game.</span></div></div>
    <div class="tut-step"><div class="num">3</div><div class="body"><strong>Find your save slot</strong><span>You'll see your save slots listed. Find the one you're playing on.</span></div></div>
    <div class="tut-step"><div class="num">4</div><div class="body"><strong>Click Download</strong><span>Click the <strong>Download</strong> button under your save slot. This saves a <code>.ic</code> file to your Downloads folder.</span></div></div>
    <div class="tut-step"><div class="num">5</div><div class="body"><strong>Open it here</strong><span>Drag that <code>.ic</code> file into the box above, or click "Browse files" to find it.</span></div></div>
  `;
  const tutStepsMac = `
    <div class="tut-step"><div class="num">1</div><div class="body"><strong>Open Infinite Craft</strong><span>Go to <code>neal.fun/infinite-craft</code> in Safari or Chrome.</span></div></div>
    <div class="tut-step"><div class="num">2</div><div class="body"><strong>Open the Menu</strong><span>Click the <strong>☰ Menu</strong> button in the top-left corner of the game.</span></div></div>
    <div class="tut-step"><div class="num">3</div><div class="body"><strong>Find your save slot</strong><span>Your save slots appear in the menu. Locate the active one.</span></div></div>
    <div class="tut-step"><div class="num">4</div><div class="body"><strong>Click Download</strong><span>Hit <strong>Download</strong> under your slot — a <code>.ic</code> file will be saved to your Downloads folder.</span></div></div>
    <div class="tut-step"><div class="num">5</div><div class="body"><strong>Open it here</strong><span>Drag the <code>.ic</code> file into the box above, or use "Browse files" to pick it.</span></div></div>
  `;
  const tutStepsMobile = `
    <div class="tut-step"><div class="num">1</div><div class="body"><strong>Open the Infinite Craft app</strong><span>Use the official <strong>Infinite Craft by Neal</strong> app on iOS or Android (not a third-party clone).</span></div></div>
    <div class="tut-step"><div class="num">2</div><div class="body"><strong>Open the Menu</strong><span>Tap the <strong>☰ Menu</strong> icon in the top-left corner of the app.</span></div></div>
    <div class="tut-step"><div class="num">3</div><div class="body"><strong>Tap Export Save</strong><span>The app has a built-in <strong>Export Save</strong> option. Tap it to save a <code>.ic</code> file to your device.</span></div></div>
    <div class="tut-step"><div class="num">4</div><div class="body"><strong>Open it here</strong><span>This editor works on mobile too — tap "Browse files" above and pick the <code>.ic</code> file you just saved.</span></div></div>
  `;

  openModal({
    title: "Open Save File",
    bodyHtml: `
      <div id="open-modal-dropzone">
        <div class="dz-icon">📁</div>
        <div class="dz-title">Drag &amp; drop your save file here</div>
        <div class="dz-sub">Supports <code style="font-size:11px;background:var(--bg-3);padding:1px 5px;border-radius:4px;border:1px solid var(--border);font-family:var(--mono);color:var(--accent);">.ic</code> files from Infinite Craft</div>
        <button class="dz-btn" id="dz-browse-btn">Browse files…</button>
        <input type="file" id="dz-file-input" accept=".ic">
      </div>

      <button class="tutorial-toggle" id="tut-toggle">
        <span>📖 How do I get my save file?</span>
        <span class="arr">▶</span>
      </button>
      <div class="tutorial-steps" id="tut-steps">
        <div class="tut-platform-tabs">
          <button class="tut-ptab active" data-os="windows">Windows</button>
          <button class="tut-ptab" data-os="mac">Mac</button>
          <button class="tut-ptab" data-os="mobile">Mobile</button>
        </div>
        <div class="tut-os-block active" id="tut-windows">${tutStepsWindows}</div>
        <div class="tut-os-block" id="tut-mac">${tutStepsMac}</div>
        <div class="tut-os-block" id="tut-mobile">${tutStepsMobile}</div>
      </div>
    `,
    footerButtons: [
      {label: "Cancel", onClick: closeModal}
    ],
    onMount: (overlay) => {
      const dropzone = overlay.querySelector("#open-modal-dropzone");
      const dzInput  = overlay.querySelector("#dz-file-input");
      const browseBtn = overlay.querySelector("#dz-browse-btn");
      const tutToggle = overlay.querySelector("#tut-toggle");
      const tutStepsEl = overlay.querySelector("#tut-steps");

      // Browse button
      browseBtn.addEventListener("click", (e)=>{ e.stopPropagation(); dzInput.click(); });
      dzInput.addEventListener("change", (e)=>{
        if(e.target.files[0]){ closeModal(); openFileObject(e.target.files[0]); }
        e.target.value = "";
      });

      // Click anywhere on dropzone also opens picker
      dropzone.addEventListener("click", (e)=>{
        if(e.target === browseBtn || e.target === dzInput) return;
        dzInput.click();
      });

      // Drag-and-drop inside the modal dropzone
      dropzone.addEventListener("dragover", (e)=>{ e.preventDefault(); dropzone.classList.add("drag-over"); });
      dropzone.addEventListener("dragleave", ()=>dropzone.classList.remove("drag-over"));
      dropzone.addEventListener("drop", (e)=>{
        e.preventDefault(); e.stopPropagation();
        dropzone.classList.remove("drag-over");
        const file = e.dataTransfer.files[0];
        if(file){ closeModal(); openFileObject(file); }
      });

      // Tutorial accordion
      tutToggle.addEventListener("click", ()=>{
        const open = tutStepsEl.classList.toggle("open");
        tutToggle.classList.toggle("open", open);
      });

      // Platform tabs
      overlay.querySelectorAll(".tut-ptab").forEach(tab=>{
        tab.addEventListener("click", ()=>{
          overlay.querySelectorAll(".tut-ptab").forEach(t=>t.classList.remove("active"));
          overlay.querySelectorAll(".tut-os-block").forEach(b=>b.classList.remove("active"));
          tab.classList.add("active");
          overlay.querySelector("#tut-"+tab.dataset.os).classList.add("active");
        });
      });
    }
  });
}

function planApiRecipeImport(steps){
  const byNameLower = new Map(state.save.items.map(it=>[it.text.trim().toLowerCase(), it]));
  const newPending = new Map();
  let nextId = nextFreeId(state.save);

  function resolve(obj){
    // obj has {id: name, emoji}
    const key = obj.id.trim().toLowerCase();
    if(byNameLower.has(key)) return {existing: true, id: byNameLower.get(key).id, text: byNameLower.get(key).text};
    if(newPending.has(key)) return {existing: false, id: newPending.get(key).plannedId, text: newPending.get(key).text};
    const plannedId = nextId++;
    newPending.set(key, {text: obj.id, emoji: obj.emoji, plannedId});
    return {existing: false, id: plannedId, text: obj.id};
  }

  const recipeActions = [];
  const dupSkipped = [];
  for(const step of steps){
    const aRes = resolve(step.a);
    const bRes = resolve(step.b);
    const rRes = resolve(step.result);
    
    let alreadyExists = false;
    if(byNameLower.has(step.result.id.trim().toLowerCase())){
      const resultItem = byNameLower.get(step.result.id.trim().toLowerCase());
      const key = [aRes.id, bRes.id].slice().sort((x,y)=>x-y).join(",");
      alreadyExists = (resultItem.recipes||[]).some(r => [...r].sort((x,y)=>x-y).join(",") === key);
    }
    if(alreadyExists){ dupSkipped.push(step); continue; }
    recipeActions.push({ a: aRes.id, b: bRes.id, resultId: rRes.id, step });
  }

  return { newElements: [...newPending.values()], recipeActions, dupSkipped };
}

function applyApiRecipeImport(plan){
  pushHistory();
  for(const ne of plan.newElements){
    state.save.items.push({ id: ne.plannedId, text: ne.text, emoji: ne.emoji, recipes: [] });
  }
  const byId = itemsById(state.save);
  for(const action of plan.recipeActions){
    const resultItem = byId.get(action.resultId);
    if(!resultItem) continue;
    if(!resultItem.recipes) resultItem.recipes = [];
    resultItem.recipes.push([action.a, action.b]);
  }
  commit();
  fullRender();
}

/* =========================================================================
   PASTE-TO-IMPORT RECIPES
   Parses lines like "Earth + Water = Plant" and, for each line:
     - finds or creates each named element (by case-insensitive name match)
     - adds the recipe [idA, idB] to the result element if not already present
   New elements get a placeholder emoji (❓) that the user can fix afterward.
   ========================================================================= */
const RECIPE_LINE_RE = /^\s*(.+?)\s*\+\s*(.+?)\s*=\s*(.+?)\s*$/;

function parseRecipeText(text){
  const lines = text.split(/\r?\n/);
  const parsed = [];
  const errors = [];
  lines.forEach((line, i)=>{
    const trimmed = line.trim();
    if(!trimmed) return; // skip blank lines
    const m = trimmed.match(RECIPE_LINE_RE);
    if(!m){
      errors.push({line: i+1, text: trimmed, reason: "Doesn't match 'A + B = Result' format"});
      return;
    }
    const [, a, b, result] = m;
    if(!a || !b || !result){
      errors.push({line: i+1, text: trimmed, reason: "Missing a name"});
      return;
    }
    parsed.push({a: a.trim(), b: b.trim(), result: result.trim(), lineNum: i+1, raw: trimmed});
  });
  return {parsed, errors};
}

function planRecipeImport(save, parsedLines){
  // Build a case-insensitive name -> existing item lookup, but also track
  // names newly introduced within this paste so repeated mentions resolve
  // to the same (not-yet-created) element instead of creating duplicates.
  const byNameLower = new Map(save.items.map(it=>[it.text.trim().toLowerCase(), it]));
  const newPending = new Map(); // lower name -> {text, emoji, plannedId}
  let nextId = nextFreeId(save);

  function resolve(name){
    const key = name.trim().toLowerCase();
    if(byNameLower.has(key)) return {existing: true, id: byNameLower.get(key).id, text: byNameLower.get(key).text};
    if(newPending.has(key)) return {existing: false, id: newPending.get(key).plannedId, text: newPending.get(key).text};
    const plannedId = nextId++;
    newPending.set(key, {text: name.trim(), emoji: "❓", plannedId});
    return {existing: false, id: plannedId, text: name.trim()};
  }

  const recipeActions = []; // {resultId, a, b, isNewRecipe, resultText}
  const dupSkipped = [];
  for(const line of parsedLines){
    const aRes = resolve(line.a);
    const bRes = resolve(line.b);
    const rRes = resolve(line.result);
    // check for an existing identical recipe on the result element (existing elements only;
    // pending/new elements can't have recipes yet so it's always new for them)
    let alreadyExists = false;
    if(byNameLower.has(line.result.trim().toLowerCase())){
      const resultItem = byNameLower.get(line.result.trim().toLowerCase());
      const key = [aRes.id, bRes.id].slice().sort((x,y)=>x-y).join(",");
      alreadyExists = (resultItem.recipes||[]).some(r => [...r].sort((x,y)=>x-y).join(",") === key);
    }
    if(alreadyExists){
      dupSkipped.push(line);
      continue;
    }
    recipeActions.push({ a: aRes.id, b: bRes.id, resultId: rRes.id, line });
  }

  return {
    newElements: [...newPending.values()],
    recipeActions,
    dupSkipped
  };
}

function applyRecipeImport(plan){
  pushHistory();
  for(const ne of plan.newElements){
    state.save.items.push({ id: ne.plannedId, text: ne.text, emoji: ne.emoji, recipes: [] });
  }
  const byId = itemsById(state.save);
  for(const action of plan.recipeActions){
    const resultItem = byId.get(action.resultId);
    if(!resultItem) continue;
    if(!resultItem.recipes) resultItem.recipes = [];
    resultItem.recipes.push([action.a, action.b]);
  }
  commit();
  fullRender();
}

function openImportRecipesModal(){
  openModal({
    title: "Import Recipes from Text",
    wide: true,
    bodyHtml: `
      <p class="small muted">Paste lines in the form <code>Ingredient A + Ingredient B = Result</code>, one per line. Elements that don't already exist in your save will be created automatically (with a placeholder ❓ emoji you can edit afterward).</p>
      <textarea class="field-input" id="recipe-paste-box" rows="9" style="font-family:var(--mono);font-size:12px;resize:vertical;" placeholder="Earth + Water = Plant
Earth + Wind = Dust
Dust + Fire = Ash
Dust + Plant = Pollen
Ash + Pollen = Cough"></textarea>
      <div class="flex gap8" style="margin-top:8px;">
        <button class="tbtn" id="recipe-preview-btn">Preview</button>
        <span class="small muted" id="recipe-paste-hint"></span>
      </div>
      <div id="recipe-preview-area" style="margin-top:14px;"></div>
    `,
    footerButtons: [
      {label:"Cancel", onClick: closeModal},
      {label:"Import", primary:true, onClick: ()=>{
        const text = document.getElementById("recipe-paste-box").value;
        const {parsed, errors} = parseRecipeText(text);
        if(parsed.length===0){ toast("No valid recipe lines found","error"); return; }
        const plan = planRecipeImport(state.save, parsed);
        applyRecipeImport(plan);
        closeModal();
        toast(`Imported ${plan.recipeActions.length} recipe(s), added ${plan.newElements.length} new element(s)`, "success");
      }}
    ],
    onMount: (overlay)=>{
      const box = overlay.querySelector("#recipe-paste-box");
      box.focus();
      overlay.querySelector("#recipe-preview-btn").onclick = ()=>{
        const text = box.value;
        const {parsed, errors} = parseRecipeText(text);
        const previewArea = overlay.querySelector("#recipe-preview-area");
        if(parsed.length===0 && errors.length===0){
          previewArea.innerHTML = `<div class="muted small">Nothing to preview yet — paste some recipe lines above.</div>`;
          return;
        }
        const plan = planRecipeImport(state.save, parsed);
        previewArea.innerHTML = `
          <div class="stat-grid" style="margin-bottom:12px;">
            <div class="stat-card"><div class="num">${plan.newElements.length}</div><div class="lbl">New elements to create</div></div>
            <div class="stat-card"><div class="num">${plan.recipeActions.length}</div><div class="lbl">Recipes to add</div></div>
            <div class="stat-card ${plan.dupSkipped.length?'warn':''}"><div class="num">${plan.dupSkipped.length}</div><div class="lbl">Already exist (skipped)</div></div>
            <div class="stat-card ${errors.length?'danger':''}"><div class="num">${errors.length}</div><div class="lbl">Lines that couldn't be parsed</div></div>
          </div>
          ${plan.newElements.length ? `
            <div class="small" style="margin-bottom:4px;font-weight:700;color:var(--text-1);">New elements</div>
            <div class="stat-list" style="margin-bottom:12px;">
              ${plan.newElements.map(ne=>`<div class="stat-list-row"><span class="k">❓ ${escapeHtml(ne.text)}</span><span class="v muted">new</span></div>`).join("")}
            </div>` : ""}
          ${errors.length ? `
            <div class="small" style="margin-bottom:4px;font-weight:700;color:var(--danger);">Unparsed lines</div>
            <div class="stat-list">
              ${errors.map(e=>`<div class="stat-list-row"><span class="k" style="color:var(--danger)">Line ${e.line}: "${escapeHtml(e.text)}"</span><span class="v muted small">${escapeHtml(e.reason)}</span></div>`).join("")}
            </div>` : ""}
        `;
      };
    }
  });
}

/* =========================================================================
   MERGE / COMPARE
   ========================================================================= */
function mergeSaves(otherSave, strategy){
  // strategy: 'keepFirst' keeps original IDs when name collides; otherwise renumber
  pushHistory();
  const existingNames = new Map(state.save.items.map(it=>[it.text.trim().toLowerCase(), it.id]));
  const idMap = new Map(); // other id -> final id in merged save
  let nextId = nextFreeId(state.save);
  const newItems = [];

  for(const it of otherSave.items){
    const nameKey = it.text.trim().toLowerCase();
    if(existingNames.has(nameKey)){
      idMap.set(it.id, existingNames.get(nameKey));
    } else {
      const assigned = nextId++;
      idMap.set(it.id, assigned);
      newItems.push({...clone(it), id: assigned});
    }
  }
  // remap recipes of new items
  for(const it of newItems){
    it.recipes = (it.recipes||[]).map(r => r.map(ing => idMap.has(ing) ? idMap.get(ing) : ing));
  }
  state.save.items.push(...newItems);
  commit();
  fullRender();
  toast(`Merged ${newItems.length} new element(s) from "${otherSave.name||'save'}"`, "success");
}

function diffSaves(saveA, saveB){
  const aById = new Map(saveA.items.map(it=>[it.id,it]));
  const bByName = new Map(saveB.items.map(it=>[it.text.trim().toLowerCase(),it]));
  const aByName = new Map(saveA.items.map(it=>[it.text.trim().toLowerCase(),it]));
  const added = [], removed = [], modified = [];
  for(const [name, it] of bByName){
    if(!aByName.has(name)) added.push(it);
  }
  for(const [name, it] of aByName){
    if(!bByName.has(name)) removed.push(it);
    else {
      const other = bByName.get(name);
      if(it.emoji !== other.emoji || (it.recipes||[]).length !== (other.recipes||[]).length){
        modified.push({a:it,b:other});
      }
    }
  }
  return {added, removed, modified};
}

function openMergeModal(){
  openModal({
    title: "Merge Save",
    bodyHtml: `
      <p class="small muted">Choose a second <code>.ic</code> file. New elements (matched by name) will be added to your current save with renumbered IDs as needed; matching names will be linked by ID automatically.</p>
      <input type="file" id="merge-file-input" accept=".ic" class="field-input">
      <div id="merge-status" class="small muted" style="margin-top:8px;"></div>
    `,
    footerButtons: [
      {label:"Cancel", onClick: closeModal},
      {label:"Merge", primary:true, onClick: async ()=>{
        const input = document.getElementById("merge-file-input");
        if(!input.files[0]){ toast("Choose a file first","error"); return; }
        try{
          const buf = await input.files[0].arrayBuffer();
          const u8 = new Uint8Array(buf);
          const jsonBytes = (u8[0]===0x1f && u8[1]===0x8b) ? await GZ.gunzip(u8) : u8;
          const other = JSON.parse(new TextDecoder().decode(jsonBytes));
          mergeSaves(other);
          closeModal();
        }catch(e){ toast("Failed to read file: "+e.message, "error"); }
      }}
    ]
  });
}

function openCompareModal(){
  openModal({
    title: "Compare Saves",
    wide: true,
    bodyHtml: `
      <p class="small muted">Choose a second <code>.ic</code> file to compare against your currently loaded save.</p>
      <input type="file" id="compare-file-input" accept=".ic" class="field-input">
      <div id="compare-result" style="margin-top:14px;max-height:50vh;overflow:auto;"></div>
    `,
    footerButtons: [
      {label:"Close", onClick: closeModal}
    ],
    onMount: ()=>{
      document.getElementById("compare-file-input").addEventListener("change", async (e)=>{
        const file = e.target.files[0];
        if(!file) return;
        try{
          const buf = await file.arrayBuffer();
          const u8 = new Uint8Array(buf);
          const jsonBytes = (u8[0]===0x1f && u8[1]===0x8b) ? await GZ.gunzip(u8) : u8;
          const other = JSON.parse(new TextDecoder().decode(jsonBytes));
          const diff = diffSaves(state.save, other);
          const resultEl = document.getElementById("compare-result");
          resultEl.innerHTML = `
            <table class="diff-table">
              <thead><tr><th>Status</th><th>Element</th><th>Detail</th></tr></thead>
              <tbody>
                ${diff.added.map(it=>`<tr><td class="diff-add">+ Added</td><td>${escapeHtml(it.emoji)} ${escapeHtml(it.text)}</td><td>only in compared file</td></tr>`).join("")}
                ${diff.removed.map(it=>`<tr><td class="diff-rem">− Removed</td><td>${escapeHtml(it.emoji)} ${escapeHtml(it.text)}</td><td>only in current save</td></tr>`).join("")}
                ${diff.modified.map(m=>`<tr><td class="diff-mod">~ Modified</td><td>${escapeHtml(m.a.emoji)} ${escapeHtml(m.a.text)}</td><td>${(m.a.recipes||[]).length} vs ${(m.b.recipes||[]).length} recipes${m.a.emoji!==m.b.emoji?', emoji differs':''}</td></tr>`).join("")}
              </tbody>
            </table>
            <div class="small muted" style="margin-top:8px;">${diff.added.length} added · ${diff.removed.length} removed · ${diff.modified.length} modified</div>
          `;
        }catch(err){ toast("Failed to read file: "+err.message, "error"); }
      });
    }
  });
}

/* =========================================================================
   BACKUPS MODAL
   ========================================================================= */
function renderBackupsModalIfOpen(){
  const overlay = document.getElementById("active-modal-overlay");
  if(overlay && overlay.dataset.kind === "backups") openBackupsModal();
}
function openBackupsModal(){
  const list = getBackups();
  openModal({
    title: "Backups",
    bodyHtml: `
      <button class="tbtn primary" id="create-backup-btn" style="margin-bottom:12px;">＋ Create Backup Now</button>
      <div id="backup-list">
        ${list.length ? list.map(b=>`
          <div class="backup-item">
            <div>
              <div class="name">${escapeHtml(b.name||"Untitled")}</div>
              <div class="meta">${new Date(b.at).toLocaleString()} · ${b.data.items.length} elements</div>
            </div>
            <div class="flex gap6">
              <button class="tbtn" data-restore="${b.id}">Restore</button>
              <button class="tbtn danger" data-remove="${b.id}">✕</button>
            </div>
          </div>
        `).join("") : '<div class="muted small">No backups yet.</div>'}
      </div>
    `,
    footerButtons: [{label:"Close", onClick: closeModal}],
    onMount: (overlay)=>{
      overlay.dataset.kind = "backups";
      overlay.querySelector("#create-backup-btn").onclick = ()=>{ createBackup(); };
      overlay.querySelectorAll("[data-restore]").forEach(b=>{
        b.onclick = ()=>{
          const backup = getBackups().find(x=>x.id===b.dataset.restore);
          if(!backup) return;
          pushHistory();
          state.save = clone(backup.data);
          markSaveDirty();
          fullRender();
          closeModal();
          toast("Restored backup", "success");
        };
      });
      overlay.querySelectorAll("[data-remove]").forEach(b=>{
        b.onclick = ()=>{
          const list2 = getBackups().filter(x=>x.id!==b.dataset.remove);
          saveBackups(list2);
          openBackupsModal();
        };
      });
    }
  });
}

/* =========================================================================
   TOP-LEVEL RENDER + EVENTS
   ========================================================================= */
function fullRender(){
  renderLeftSidebar();
  renderCenter();
  renderInspector();
  if(!state.lowEndMode){
    initGraphLayout();
    renderGraph();
  }
  document.getElementById("savename-display").textContent = state.save ? (state.save.name||"Untitled") + (state.filePath?` (${state.filePath})`:"") : "No save loaded";
  updateUndoRedoButtons();
}

function applyLowEndMode(){
  document.body.classList.toggle("lowend", state.lowEndMode);
  const btn = document.getElementById("btn-lowend");
  btn.classList.toggle("primary", state.lowEndMode);
  btn.title = state.lowEndMode ? "Low-end mode is ON (graph disabled) — click to re-enable graph" : "Low-end mode (disable graph)";
  const omenuBtn = document.getElementById("omenu-lowend");
  if(omenuBtn) omenuBtn.classList.toggle("active", state.lowEndMode);
  localStorage.setItem(LS_LOWEND, state.lowEndMode ? "1" : "0");
  if(state.lowEndMode){
    // free up memory/DOM held by the graph since it's no longer shown
    state.graph.nodes.clear();
    edgesG.innerHTML = "";
    nodesG.innerHTML = "";
  } else {
    initGraphLayout();
    renderGraph();
  }
}

document.getElementById("btn-open").addEventListener("click", openSaveModal);
document.getElementById("file-input").addEventListener("change", (e)=>{
  if(e.target.files[0]){ closeModal(); openFileObject(e.target.files[0]); }
  e.target.value = "";
});
document.getElementById("btn-export-ic").addEventListener("click", exportIc);
document.getElementById("btn-export-json").addEventListener("click", exportJson);
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-redo").addEventListener("click", redo);
document.getElementById("btn-merge").addEventListener("click", openMergeModal);
document.getElementById("btn-compare").addEventListener("click", openCompareModal);
document.getElementById("btn-backups").addEventListener("click", openBackupsModal);
document.getElementById("btn-import-recipes").addEventListener("click", openImportRecipesModal);
document.getElementById("btn-api-lookup").addEventListener("click", openApiLookupModal);
document.getElementById("btn-dedupe").addEventListener("click", openDedupeModal);
document.getElementById("btn-darkmode").addEventListener("click", ()=>{
  state.darkmode = !state.darkmode;
  applyTheme();
  toast(state.darkmode ? "Dark mode enabled" : "Light mode enabled");
});
function applyTheme(){
  document.body.classList.toggle("light-theme", !state.darkmode);
  document.getElementById("btn-darkmode").textContent = state.darkmode ? "🌙" : "☀️";
  localStorage.setItem(LS_THEME, state.darkmode?"dark":"light");
}

document.getElementById("btn-lowend").addEventListener("click", ()=>{
  state.lowEndMode = !state.lowEndMode;
  applyLowEndMode();
  toast(state.lowEndMode ? "Low-end mode enabled — graph disabled" : "Low-end mode disabled — graph restored");
});

document.getElementById("btn-about").addEventListener("click", ()=>{
  openModal({
    title: "About InfiniEdit",
    bodyHtml: `
      <p>InfiniEdit is a free, browser-based save editor for <strong>Infinite Craft</strong>. Edit elements and recipes, analyze saves, visualize dependencies, and look up recipes live. Everything runs locally in your browser — your save files are never uploaded anywhere.</p>
      <p class="small muted" style="margin-top:12px;">InfiniEdit is an unofficial fan-made project and is not affiliated with, endorsed by, or associated with Infinite Craft or its creators.</p>
      <div style="margin-top:16px;">
        <p><strong>What file formats does it support?</strong><br>Opens and exports .ic save files, and can export your save data as JSON.</p>
        <p><strong>Is it free?</strong><br>Yes — completely free, no account or sign-up required.</p>
        <p><strong>What else can it do?</strong><br>Analyze a save for duplicate recipes, dead ends, and unreachable elements; merge or compare two saves; deduplicate elements; import pasted recipes; and look up elements live via the InfiniBrowser API.</p>
      </div>
      <div style="margin-top:16px;display:flex;flex-direction:column;gap:8px;">
        <a href="https://github.com/QikSeekDev/InfiniEdit" target="_blank" rel="noopener">🔗 Source code on GitHub</a>
        <a href="https://github.com/QikSeekDev/InfiniEdit/issues" target="_blank" rel="noopener">🐛 Report a bug / request a feature</a>
      </div>
    `,
    footerButtons: [
      {label:"Close", primary:true, onClick: closeModal}
    ]
  });
});

document.querySelectorAll(".tabbtn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tabbtn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    state.centerTab = btn.dataset.tab;
    renderCenter();
  });
});

/* =========================================================================
   MOBILE NAV: drawer sidebars + backdrop + overflow menu
   ========================================================================= */
(function mobileNav(){
  const left = document.getElementById("sidebar-left");
  const right = document.getElementById("sidebar-right");
  const backdrop = document.getElementById("mobile-backdrop");
  const menuBtn = document.getElementById("btn-mobile-menu");
  const inspectorBtn = document.getElementById("btn-mobile-inspector");
  const moreBtn = document.getElementById("btn-more");
  const moreMenu = document.getElementById("overflow-menu");

  function closeDrawers(){
    left.classList.remove("open");
    right.classList.remove("open");
    backdrop.classList.remove("show");
    menuBtn.classList.remove("open");
  }
  function openDrawer(panel){
    closeDrawers();
    panel.classList.add("open");
    backdrop.classList.add("show");
    if(panel === left) menuBtn.classList.add("open");
  }
  menuBtn.addEventListener("click", ()=>{
    if(left.classList.contains("open")) closeDrawers();
    else openDrawer(left);
  });
  inspectorBtn.addEventListener("click", ()=>{
    if(right.classList.contains("open")) closeDrawers();
    else openDrawer(right);
  });
  backdrop.addEventListener("click", closeDrawers);
  window.addEventListener("keydown", (e)=>{ if(e.key==="Escape") closeDrawers(); });

  moreBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    const opening = !moreMenu.classList.contains("show");
    if(opening) positionOverflowMenu();
    moreMenu.classList.toggle("show", opening);
  });
  function positionOverflowMenu(){
    const r = moreBtn.getBoundingClientRect();
    const menuW = 200, margin = 8;
    // default: below and right-aligned to the button
    let left = r.right - menuW;
    let top = r.bottom + 6;
    // clamp horizontally within viewport
    left = Math.max(margin, Math.min(left, window.innerWidth - menuW - margin));
    // if there isn't room below, open upward instead
    const estHeight = Math.min(400, moreMenu.scrollHeight || 260);
    if(top + estHeight > window.innerHeight - margin){
      top = Math.max(margin, r.top - estHeight - 6);
    }
    moreMenu.style.left = left + "px";
    moreMenu.style.top = top + "px";
  }
  window.addEventListener("resize", ()=>{
    if(moreMenu.classList.contains("show")) positionOverflowMenu();
  });
  document.querySelectorAll(".omenu-item").forEach(item=>{
    item.addEventListener("click", ()=>{
      moreMenu.classList.remove("show");
      const target = document.getElementById(item.dataset.forward);
      if(target) target.click();
    });
  });
  document.addEventListener("click", (e)=>{
    if(!moreMenu.contains(e.target) && e.target!==moreBtn) moreMenu.classList.remove("show");
  });

  // close the drawer automatically once the viewport grows back to desktop size
  window.addEventListener("resize", ()=>{
    if(window.innerWidth > 900) closeDrawers();
  });
})();

/* drag & drop */
let dragCounter = 0;
window.addEventListener("dragenter", (e)=>{
  e.preventDefault();
  dragCounter++;
  document.getElementById("dropzone-overlay").classList.add("active");
});
window.addEventListener("dragover", (e)=>e.preventDefault());
window.addEventListener("dragleave", (e)=>{
  dragCounter--;
  if(dragCounter<=0){ document.getElementById("dropzone-overlay").classList.remove("active"); dragCounter=0; }
});
window.addEventListener("drop", (e)=>{
  e.preventDefault();
  dragCounter = 0;
  document.getElementById("dropzone-overlay").classList.remove("active");
  const file = e.dataTransfer.files[0];
  if(file) openFileObject(file);
});


/* keyboard shortcuts */
const KEYBOARD_SHORTCUTS = [
  {keys:"Ctrl/⌘ O", desc:"Open a save file"},
  {keys:"Ctrl/⌘ S", desc:"Export .ic"},
  {keys:"Ctrl/⌘ Z", desc:"Undo"},
  {keys:"Ctrl/⌘ Y or Ctrl/⌘ Shift Z", desc:"Redo"},
  {keys:"Delete", desc:"Delete selected element"},
  {keys:"F2", desc:"Rename/edit selected element"},
  {keys:"Ctrl/⌘ /", desc:"Show this shortcuts list"},
  {keys:"Esc", desc:"Close a modal or menu"}
];
function openShortcutsModal(){
  const rows = KEYBOARD_SHORTCUTS.map(s=>
    `<div class="shortcut-row"><kbd>${escapeHtml(s.keys)}</kbd><span>${escapeHtml(s.desc)}</span></div>`
  ).join("");
  openModal({
    title: "⌨ Keyboard Shortcuts",
    bodyHtml: `<div class="shortcut-list">${rows}</div>`,
    footerButtons: [{label:"Close", onClick: closeModal}]
  });
}
window.addEventListener("keydown", (e)=>{
  const mod = e.ctrlKey || e.metaKey;
  if(mod && e.key.toLowerCase()==="o"){ e.preventDefault(); document.getElementById("file-input").click(); }
  else if(mod && e.key.toLowerCase()==="s"){ e.preventDefault(); exportIc(); }
  else if(mod && e.key.toLowerCase()==="z" && !e.shiftKey){ e.preventDefault(); undo(); }
  else if((mod && e.key.toLowerCase()==="y") || (mod && e.shiftKey && e.key.toLowerCase()==="z")){ e.preventDefault(); redo(); }
  else if(e.key === "Delete" && state.selectedId!=null && !isTyping(e.target)){ e.preventDefault(); deleteElement(state.selectedId); }
  else if(e.key === "F2" && state.selectedId!=null && !isTyping(e.target)){ e.preventDefault(); editElement(state.selectedId); }
  else if(mod && e.key === "/"){ e.preventDefault(); openShortcutsModal(); }
});
function isTyping(el){
  return el && (el.tagName==="INPUT" || el.tagName==="TEXTAREA" || el.isContentEditable);
}
const shortcutsBtnEl = document.getElementById("btn-shortcuts");
if(shortcutsBtnEl) shortcutsBtnEl.addEventListener("click", openShortcutsModal);

/* panel resizing */
function makeResizer(handleId, panelId, side){
  const handle = document.getElementById(handleId);
  const panel = document.getElementById(panelId);
  let dragging = false, startX, startWidth;
  handle.addEventListener("pointerdown", (e)=>{
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.classList.add("active");
    document.body.style.userSelect = "none";
  });
  handle.addEventListener("pointermove", (e)=>{
    if(!dragging) return;
    const dx = e.clientX - startX;
    let newWidth = side==="left" ? startWidth+dx : startWidth-dx;
    newWidth = Math.max(180, Math.min(560, newWidth));
    panel.style.width = newWidth+"px";
  });
  function stop(){
    if(dragging){ dragging=false; handle.classList.remove("active"); document.body.style.userSelect=""; setTimeout(()=>renderGraph(),0); }
  }
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}
makeResizer("resizer-left", "sidebar-left", "left");
makeResizer("resizer-right", "sidebar-right", "right");

(function makeGraphResizer(){
  const handle = document.getElementById("graph-resizer");
  const panel = document.getElementById("graphpanel");
  let dragging=false, startY, startHeight;
  handle.addEventListener("pointerdown",(e)=>{
    dragging=true;
    handle.setPointerCapture(e.pointerId);
    startY=e.clientY; startHeight=panel.getBoundingClientRect().height;
    handle.classList.add("active");
    document.body.style.userSelect="none";
  });
  handle.addEventListener("pointermove",(e)=>{
    if(!dragging) return;
    const dy = startY - e.clientY;
    let newHeight = startHeight + dy;
    newHeight = Math.max(120, Math.min(window.innerHeight*0.75, newHeight));
    panel.style.height = newHeight+"px";
  });
  function stop(){
    if(dragging){ dragging=false; handle.classList.remove("active"); document.body.style.userSelect=""; setTimeout(()=>renderGraph(),0); }
  }
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
})();

window.addEventListener("resize", ()=>{ if(!state.lowEndMode) renderGraph(); });

window.addEventListener("beforeunload", (e)=>{
  if(state.save){ autosave(); }
});

/* =========================================================================
   INIT
   ========================================================================= */
(function init(){
  const theme = localStorage.getItem(LS_THEME);
  state.darkmode = theme !== "light";
  applyTheme();

  state.lowEndMode = localStorage.getItem(LS_LOWEND) === "1";
  document.body.classList.toggle("lowend", state.lowEndMode);
  const lowendBtn = document.getElementById("btn-lowend");
  lowendBtn.classList.toggle("primary", state.lowEndMode);
  lowendBtn.title = state.lowEndMode ? "Low-end mode is ON (graph disabled) — click to re-enable graph" : "Low-end mode (disable graph)";
  const omenuLowendBtn = document.getElementById("omenu-lowend");
  if(omenuLowendBtn) omenuLowendBtn.classList.toggle("active", state.lowEndMode);

  const auto = loadAutosave();
  if(auto && auto.items){
    state.save = auto;
    markSaveDirty();
  } else {
    // First-time visitor: start them off with the default save instead of a blank slate.
    state.save = clone(DEFAULT_SAVE_DATA);
    markSaveDirty();
    state.save.created = Date.now();
    state.save.updated = Date.now();
    autosave();
  }
  // Defer render until after first paint — keeps initial skeleton stable (CLS fix)
  requestAnimationFrame(()=>{
    fullRender();
    document.getElementById("app").style.opacity="1";
    if(auto && auto.items) toast("Restored your last session from autosave");
  });
})();

/* =========================================================================
   WEBMCP — expose editor actions as tools for AI agents
   Spec: https://webmachinelearning.github.io/webmcp/
   Uses document.modelContext.registerTool() (current spec API). Runs inside
   this file's outer IIFE so it can close over `state` and the editor's
   internal helper functions without polluting the global scope.
   ========================================================================= */
(function registerWebMcpTools(){
  // Chrome originally shipped WebMCP on navigator.modelContext (Feb 2026).
  // The spec later moved it to document.modelContext. Chrome now deprecates
  // navigator.modelContext in favor of document.modelContext but keeps it as
  // a backward-compat alias during the transition. Some external scanners
  // (e.g. Cloudflare's isitagentready.com, as of this writing) still check
  // navigator.modelContext specifically. Check both, prefer the spec-current one.
  const mc = document.modelContext || navigator.modelContext;
  if(!mc){
    // WebMCP not supported in this browser — no-op.
    return;
  }

  function requireSave(){
    if(!state.save) throw new Error("No save is currently loaded in the editor.");
    return state.save;
  }

  function findElementByNameOrId(query){
    const save = requireSave();
    if(typeof query === "number" || /^\d+$/.test(String(query))){
      const id = parseInt(query, 10);
      const byId = itemsById(save);
      if(byId.has(id)) return byId.get(id);
    }
    const lower = String(query).trim().toLowerCase();
    return save.items.find(it => it.text.toLowerCase() === lower)
        || save.items.find(it => it.text.toLowerCase().includes(lower));
  }

  mc.registerTool({
    name: "get_save_summary",
    title: "Get save summary",
    description: "Returns high-level stats about the currently loaded Infinite Craft save: save name, element count, recipe count, and discovery count. Use this first to understand what's loaded before calling other tools.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const save = requireSave();
      const recipeCount = save.items.reduce((n, it) => n + (it.recipes ? it.recipes.length : 0), 0);
      const discoveredCount = save.items.filter(it => it.discovery === 1).length;
      return {
        name: save.name,
        elementCount: save.items.length,
        recipeCount,
        discoveredCount
      };
    }
  });

  mc.registerTool({
    name: "search_elements",
    title: "Search elements",
    description: "Searches the currently loaded save for elements whose name contains the given text (case-insensitive). Returns matching elements with id, name, and emoji. Use this to find an element's id before editing or referencing it in a recipe.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to search for in element names. Empty string returns all elements (capped at 'limit')." },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 25." }
      },
      required: ["query"]
    },
    annotations: { readOnlyHint: true },
    execute: async ({ query, limit }) => {
      const save = requireSave();
      const cap = Number.isFinite(limit) ? limit : 25;
      const q = (query || "").trim().toLowerCase();
      const matches = save.items.filter(it => it.text.toLowerCase().includes(q));
      return {
        total: matches.length,
        results: matches.slice(0, cap).map(it => ({ id: it.id, name: it.text, emoji: it.emoji, discovered: it.discovery === 1 }))
      };
    }
  });

  mc.registerTool({
    name: "get_element",
    title: "Get element details",
    description: "Returns full details for one element: its recipes (ingredient pairs that produce it), and which other elements use it as an ingredient.",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Element name (case-insensitive) or numeric id." }
      },
      required: ["element"]
    },
    annotations: { readOnlyHint: true },
    execute: async ({ element }) => {
      const save = requireSave();
      const item = findElementByNameOrId(element);
      if(!item) throw new Error(`No element found matching "${element}".`);
      const byId = itemsById(save);
      const recipes = (item.recipes || []).map(([a, b]) => ({
        a: byId.get(a) ? byId.get(a).text : a,
        b: byId.get(b) ? byId.get(b).text : b
      }));
      const usedIn = save.items
        .filter(it => (it.recipes || []).some(r => r.includes(item.id)))
        .map(it => it.text);
      return {
        id: item.id,
        name: item.text,
        emoji: item.emoji,
        discovered: item.discovery === 1,
        recipes,
        usedIn
      };
    }
  });

  mc.registerTool({
    name: "add_element",
    title: "Add element",
    description: "Adds a new element to the currently loaded save. Does not fetch recipe data from InfiniBrowser — use add_recipe separately if you know the ingredients.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the new element." },
        emoji: { type: "string", description: "Emoji to represent the element. Defaults to ❓ if omitted." },
        firstDiscovery: { type: "boolean", description: "Mark this element as a first discovery. Defaults to false." }
      },
      required: ["name"]
    },
    annotations: { readOnlyHint: false },
    execute: async ({ name, emoji, firstDiscovery }) => {
      const save = requireSave();
      const trimmed = (name || "").trim();
      if(!trimmed) throw new Error("Element name is required.");
      if(save.items.some(it => it.text.toLowerCase() === trimmed.toLowerCase())){
        throw new Error(`An element named "${trimmed}" already exists.`);
      }
      const id = nextFreeId(save);
      pushHistory();
      const newItem = { id, text: trimmed, emoji: (emoji || "").trim() || "❓", recipes: [] };
      if(firstDiscovery) setDiscoveryFlag(newItem, true);
      save.items.push(newItem);
      commit();
      fullRender();
      toast("Added " + trimmed, "success");
      return { id, name: trimmed, emoji: newItem.emoji };
    }
  });

  mc.registerTool({
    name: "add_recipe",
    title: "Add recipe",
    description: "Adds a recipe to the save: combining ingredientA and ingredientB produces result. All three elements must already exist in the save (use add_element first if needed, or search_elements to confirm they exist).",
    inputSchema: {
      type: "object",
      properties: {
        ingredientA: { type: "string", description: "Name or id of the first ingredient." },
        ingredientB: { type: "string", description: "Name or id of the second ingredient." },
        result: { type: "string", description: "Name or id of the resulting element." }
      },
      required: ["ingredientA", "ingredientB", "result"]
    },
    annotations: { readOnlyHint: false },
    execute: async ({ ingredientA, ingredientB, result }) => {
      const save = requireSave();
      const a = findElementByNameOrId(ingredientA);
      const b = findElementByNameOrId(ingredientB);
      const r = findElementByNameOrId(result);
      if(!a) throw new Error(`Ingredient "${ingredientA}" not found.`);
      if(!b) throw new Error(`Ingredient "${ingredientB}" not found.`);
      if(!r) throw new Error(`Result element "${result}" not found.`);
      pushHistory();
      if(!r.recipes) r.recipes = [];
      r.recipes.push([a.id, b.id]);
      commit();
      fullRender();
      toast("Recipe added", "success");
      return { result: r.text, ingredientA: a.text, ingredientB: b.text };
    }
  });

  mc.registerTool({
    name: "delete_element",
    title: "Delete element",
    description: "Deletes an element from the save by name or id. This also removes any recipes that reference it as an ingredient. This is a destructive action — confirm with the user before calling this unless they explicitly asked to delete the element.",
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: "Element name (case-insensitive) or numeric id to delete." }
      },
      required: ["element"]
    },
    annotations: { readOnlyHint: false },
    execute: async ({ element }) => {
      const save = requireSave();
      const item = findElementByNameOrId(element);
      if(!item) throw new Error(`No element found matching "${element}".`);
      // Note: deleteElement() (the UI function) only opens a confirmation modal.
      // We replicate its actual deletion logic here so this tool completes
      // synchronously instead of leaving an unattended dialog open.
      pushHistory();
      save.items = save.items.filter(x => x.id !== item.id);
      if(state.selectedId === item.id) state.selectedId = null;
      commit();
      fullRender();
      toast("Deleted " + item.text, "success");
      return { deleted: item.text, id: item.id };
    }
  });

  mc.registerTool({
    name: "analyze_save",
    title: "Analyze save",
    description: "Runs the save analyzer and returns counts of duplicate recipes, dead-end elements, unreachable elements, and elements with missing dependencies.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const save = requireSave();
      const result = analyze(save);
      return {
        duplicateNameElements: (result.duplicates || []).length,
        deadEnds: (result.deadEnds || []).length,
        unreachable: (result.unreachable || []).length,
        missingDependencies: (result.missingDeps || []).length,
        totalElements: result.totalElements,
        totalRecipes: result.totalRecipes
      };
    }
  });

  mc.registerTool({
    name: "export_save",
    title: "Export save file",
    description: "Exports the currently loaded save as a downloadable .ic file, same as clicking the export button in the UI. Triggers a browser file download.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false },
    execute: async () => {
      requireSave();
      await exportIc();
      return { status: "exported" };
    }
  });

/* Register service worker for offline support / installability. */
if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(err=>{
      console.error("Service worker registration failed:", err);
    });
  });
}

})();

})();