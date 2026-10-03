/* savebox.js — 存檔匯出／匯入（檔案＋Google 雲端硬碟 appDataFolder）。
   遊戲呼叫 SaveBox.init({ game, keys, clientId })，再把 SaveBox.button() 放進介面。
   存檔內容是 keys 裡每個 localStorage 項目的原始字串；匯入或從雲端取回後重新載入頁面。
   同一個 client ID 底下的遊戲共用 appDataFolder，雲端檔名以 game 區分。 */

const SaveBox = {};

(() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  let cfg = null;
  let token = null;

  SaveBox.init = function (options) { cfg = options; };

  function snapshot() {
    const data = {};
    for (const k of cfg.keys) data[k] = localStorage.getItem(k);
    return { game: cfg.game, savedAt: new Date().toISOString(), data };
  }

  /* 寫回存檔；不是本遊戲的檔案回傳 false */
  function restore(payload) {
    if (!payload || payload.game !== cfg.game || typeof payload.data !== 'object') return false;
    for (const k of cfg.keys) {
      const v = payload.data[k];
      if (typeof v === 'string') localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    }
    return true;
  }

  function exportFile() {
    const blob = new Blob([JSON.stringify(snapshot())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cfg.game}-save-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importFile(btn) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let ok = false;
        try { ok = restore(JSON.parse(reader.result)); } catch (e) {}
        flash(btn, ok ? '✅' : '❌', ok);
      };
      reader.readAsText(file);
    };
    input.click();
  }

  /* ---- Google 雲端（GIS token client＋REST，不載 gapi） ---- */

  function ensureGis(cb) {
    if (window.google?.accounts?.oauth2) return cb(true);
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => cb(true);
    s.onerror = () => cb(false);
    document.head.appendChild(s);
  }

  function auth(cb) {
    if (token) return cb(true);
    ensureGis(ok => {
      if (!ok) return cb(false);
      try {
        google.accounts.oauth2.initTokenClient({
          client_id: cfg.clientId,
          scope: SCOPE,
          callback: t => {
            if (t && t.access_token) { token = t.access_token; cb(true); }
            else cb(false);
          },
          error_callback: () => cb(false),
        }).requestAccessToken();
      } catch (e) { cb(false); }
    });
  }

  const authHeader = () => ({ Authorization: 'Bearer ' + token });
  const cloudName = () => `${cfg.game}_save.json`;

  async function findFile() {
    const q = encodeURIComponent(`name='${cloudName()}'`);
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`,
      { headers: authHeader() });
    if (!r.ok) throw new Error('drive list ' + r.status);
    return (await r.json()).files?.[0] || null;
  }

  async function upload() {
    const body = JSON.stringify(snapshot());
    const f = await findFile();
    if (f) {
      const r = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${f.id}?uploadType=media`,
        { method: 'PATCH', headers: { ...authHeader(), 'Content-Type': 'application/json' }, body });
      if (!r.ok) throw new Error('drive update ' + r.status);
      return;
    }
    const boundary = 'savebox' + Date.now().toString(36);
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: cloudName(), parents: ['appDataFolder'] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      body + `\r\n--${boundary}--`;
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    if (!r.ok) throw new Error('drive create ' + r.status);
  }

  async function download() {
    const f = await findFile();
    if (!f) return null;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
      { headers: authHeader() });
    if (!r.ok) throw new Error('drive get ' + r.status);
    return await r.json();
  }

  function cloudUp(btn) {
    const label = btn.textContent;
    btn.textContent = '⏳';
    auth(ok => {
      if (!ok) { btn.textContent = label; return; }
      upload().then(() => flash(btn, '✅')).catch(() => flash(btn, '❌'));
    });
  }

  function cloudDown(btn) {
    const label = btn.textContent;
    btn.textContent = '⏳';
    auth(ok => {
      if (!ok) { btn.textContent = label; return; }
      download()
        .then(payload => payload ? flash(btn, restore(payload) ? '✅' : '❌', true) : flash(btn, '➖'))
        .catch(() => flash(btn, '❌'));
    });
  }

  /* ---- 介面：一顆 💾，點開是四個圖示按鈕 ---- */

  /* 短暫顯示結果；reload 為 true 時接著重新載入，讓遊戲讀進新存檔 */
  function flash(btn, mark, reload) {
    const label = btn.dataset.label;
    btn.textContent = mark;
    setTimeout(() => {
      if (reload) location.reload();
      else btn.textContent = label;
    }, 900);
  }

  function openPanel() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:grid;place-items:center;' +
      'background:rgba(20,30,40,.55);';
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    const sheet = document.createElement('div');
    sheet.style.cssText = 'display:grid;grid-template-columns:repeat(2,64px);gap:12px;padding:18px;' +
      'border-radius:20px;background:rgba(40,52,64,.92);box-shadow:0 10px 40px rgba(0,0,0,.35);';

    const add = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.label = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText = 'border:none;border-radius:14px;background:rgba(255,255,255,.16);color:#fff;' +
        'font-size:22px;width:64px;height:56px;cursor:pointer;font-family:inherit;';
      b.onclick = () => onClick(b);
      sheet.appendChild(b);
    };
    add('⬇️', '匯出存檔', () => exportFile());
    add('⬆️', '匯入存檔', importFile);
    if (cfg.clientId) {
      add('☁️⬆️', '存到雲端', cloudUp);
      add('☁️⬇️', '從雲端取回', cloudDown);
    }

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
  }

  /* 回傳 💾 按鈕；style 讓遊戲配合自己的版面 */
  SaveBox.button = function (style) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '💾';
    b.title = '存檔備份';
    b.setAttribute('aria-label', '存檔備份');
    if (style) b.style.cssText = style;
    b.onclick = e => { e.stopPropagation(); openPanel(); };
    return b;
  };
})();

if (typeof window !== 'undefined') window.SaveBox = SaveBox;
