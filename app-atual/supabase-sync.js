'use strict';

const SUPABASE_URL = 'https://raxwccnrvufyuwtxiljl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_A2ecw8TM_RV1zpS6Fxkgaw_VLw_DNsV';
const SUPABASE_TOKEN_KEY = 'material-permanente-supabase-session-v1';
const SUPABASE_REVISION_KEY = 'material-permanente-supabase-revision-v1';
const REMOTE_TABLE = 'user_app_state';
const originalInitializeData = initializeData;
const originalPersist = persist;

let syncSession = null;
let syncUser = null;
let syncTimer = null;
let syncBusy = false;
let syncReady = false;
let syncConflict = false;
let remoteRevision = Number(localStorage.getItem(SUPABASE_REVISION_KEY) || 0);

function syncHeaders({ authenticated = true, prefer = '' } = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    'Content-Type': 'application/json',
  };
  if (authenticated && syncSession?.access_token) {
    headers.Authorization = `Bearer ${syncSession.access_token}`;
  }
  if (prefer) headers.Prefer = prefer;
  return headers;
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const message = body?.msg || body?.message || body?.error_description || body?.error || `Erro ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function saveSession(session) {
  syncSession = session?.access_token ? session : null;
  if (syncSession) localStorage.setItem(SUPABASE_TOKEN_KEY, JSON.stringify(syncSession));
  else localStorage.removeItem(SUPABASE_TOKEN_KEY);
}

function restoreSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(SUPABASE_TOKEN_KEY) || 'null');
    if (stored?.access_token) syncSession = stored;
  } catch {
    localStorage.removeItem(SUPABASE_TOKEN_KEY);
  }
}

async function refreshSession() {
  if (!syncSession?.refresh_token) return false;
  try {
    const refreshed = await supabaseRequest('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: syncHeaders({ authenticated: false }),
      body: JSON.stringify({ refresh_token: syncSession.refresh_token }),
    });
    saveSession(refreshed);
    return true;
  } catch {
    saveSession(null);
    return false;
  }
}

async function getCurrentUser() {
  if (!syncSession?.access_token) return null;
  try {
    return await supabaseRequest('/auth/v1/user', { headers: syncHeaders() });
  } catch (error) {
    if (error.status === 401 && await refreshSession()) {
      return supabaseRequest('/auth/v1/user', { headers: syncHeaders() });
    }
    saveSession(null);
    return null;
  }
}

function remotePayload() {
  return {
    format: 1,
    savedAt: new Date().toISOString(),
    appState: clone(appState),
    versions: clone(versions),
    processChecklistData: clone(processChecklistData),
    processRuns: clone(processRuns),
  };
}

function validRemotePayload(payload) {
  return payload
    && payload.appState
    && Array.isArray(payload.appState.processes)
    && Array.isArray(payload.versions);
}

async function applyRemotePayload(payload) {
  if (!validRemotePayload(payload)) throw new Error('Os dados sincronizados são inválidos.');
  appState = clone(payload.appState);
  versions = clone(payload.versions);
  processChecklistData = payload.processChecklistData && typeof payload.processChecklistData === 'object'
    ? clone(payload.processChecklistData) : {};
  processRuns = payload.processRuns && typeof payload.processRuns === 'object'
    ? clone(payload.processRuns) : {};
  draftProcesses = clone(appState.processes);
  activeRunId = null;
  await originalPersist();
  renderAll();
}

async function fetchRemoteRow() {
  if (!syncUser) return null;
  const rows = await supabaseRequest(
    `/rest/v1/${REMOTE_TABLE}?select=payload,revision,updated_at&user_id=eq.${encodeURIComponent(syncUser.id)}&limit=1`,
    { headers: syncHeaders() },
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function createRemoteRow() {
  const rows = await supabaseRequest(`/rest/v1/${REMOTE_TABLE}`, {
    method: 'POST',
    headers: syncHeaders({ prefer: 'return=representation' }),
    body: JSON.stringify({
      user_id: syncUser.id,
      payload: remotePayload(),
      revision: 1,
      client_updated_at: new Date().toISOString(),
    }),
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  remoteRevision = Number(row?.revision || 1);
  localStorage.setItem(SUPABASE_REVISION_KEY, String(remoteRevision));
}

async function updateRemoteRow({ force = false } = {}) {
  const query = force
    ? `user_id=eq.${encodeURIComponent(syncUser.id)}`
    : `user_id=eq.${encodeURIComponent(syncUser.id)}&revision=eq.${remoteRevision}`;
  const rows = await supabaseRequest(`/rest/v1/${REMOTE_TABLE}?${query}`, {
    method: 'PATCH',
    headers: syncHeaders({ prefer: 'return=representation' }),
    body: JSON.stringify({
      payload: remotePayload(),
      revision: remoteRevision + 1,
      client_updated_at: new Date().toISOString(),
    }),
  });
  if (!Array.isArray(rows) || !rows.length) {
    syncConflict = true;
    throw new Error('Outra máquina salvou uma versão mais recente.');
  }
  remoteRevision = Number(rows[0].revision);
  localStorage.setItem(SUPABASE_REVISION_KEY, String(remoteRevision));
}

function setSyncStatus(label, state = '') {
  const status = document.querySelector('#cloudSyncStatus');
  if (status) {
    status.textContent = label;
    status.dataset.state = state;
  }
  const button = document.querySelector('#syncAccountBtn');
  if (button) button.textContent = syncUser ? 'Minha conta' : 'Conectar';
}

function describeSyncError(error) {
  const message = String(error?.message || error || '');
  if (/relation .* does not exist|schema cache|user_app_state/i.test(message)) {
    return 'Banco ainda não configurado';
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Sem conexão';
  if (syncConflict) return 'Conflito de versões';
  return 'Erro ao sincronizar';
}

async function pushRemote({ force = false } = {}) {
  if (!syncReady || !syncUser || syncBusy || !navigator.onLine) return;
  syncBusy = true;
  setSyncStatus('Sincronizando...', 'saving');
  try {
    const row = await fetchRemoteRow();
    if (!row) await createRemoteRow();
    else {
      if (!remoteRevision) remoteRevision = Number(row.revision || 0);
      await updateRemoteRow({ force });
    }
    syncConflict = false;
    setSyncStatus('Sincronizado', 'saved');
  } catch (error) {
    setSyncStatus(describeSyncError(error), 'error');
    if (syncConflict) openConflictDialog();
  } finally {
    syncBusy = false;
  }
}

function scheduleRemoteSave() {
  if (!syncReady || !syncUser) return;
  clearTimeout(syncTimer);
  setSyncStatus(navigator.onLine ? 'Aguardando sincronização' : 'Salvo neste aparelho', 'waiting');
  syncTimer = setTimeout(() => pushRemote(), 1200);
}

async function loadOrCreateRemote() {
  setSyncStatus('Verificando nuvem...', 'saving');
  const row = await fetchRemoteRow();
  if (!row) {
    await createRemoteRow();
    setSyncStatus('Dados enviados', 'saved');
    toast('Sua base local foi salva no Supabase.');
    return;
  }
  remoteRevision = Number(row.revision || 0);
  localStorage.setItem(SUPABASE_REVISION_KEY, String(remoteRevision));
  await applyRemotePayload(row.payload);
  setSyncStatus('Sincronizado', 'saved');
  toast('Dados sincronizados com esta conta.');
}

persist = async function syncedPersist() {
  await originalPersist();
  scheduleRemoteSave();
};

initializeData = async function syncedInitializeData() {
  await originalInitializeData();
  restoreSession();
  syncUser = await getCurrentUser();
  syncReady = true;
  if (syncUser) {
    try {
      await loadOrCreateRemote();
    } catch (error) {
      setSyncStatus(describeSyncError(error), 'error');
    }
  } else {
    setSyncStatus('Somente neste aparelho', 'local');
  }
  updateAccountView();
};

async function signIn(email, password) {
  const session = await supabaseRequest('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: syncHeaders({ authenticated: false }),
    body: JSON.stringify({ email, password }),
  });
  saveSession(session);
  syncUser = session.user;
  remoteRevision = 0;
  localStorage.removeItem(SUPABASE_REVISION_KEY);
  await loadOrCreateRemote();
  updateAccountView();
}

async function signUp(email, password) {
  const result = await supabaseRequest('/auth/v1/signup', {
    method: 'POST',
    headers: syncHeaders({ authenticated: false }),
    body: JSON.stringify({ email, password }),
  });
  if (result?.access_token) {
    saveSession(result);
    syncUser = result.user;
    await loadOrCreateRemote();
  }
  updateAccountView();
  return Boolean(result?.access_token);
}

async function signOut() {
  try {
    if (syncSession?.access_token) {
      await supabaseRequest('/auth/v1/logout', { method: 'POST', headers: syncHeaders() });
    }
  } catch {}
  saveSession(null);
  syncUser = null;
  remoteRevision = 0;
  localStorage.removeItem(SUPABASE_REVISION_KEY);
  updateAccountView();
  setSyncStatus('Somente neste aparelho', 'local');
  toast('Conta desconectada. Seus dados locais foram mantidos.');
}

function updateAccountView() {
  const email = document.querySelector('#syncUserEmail');
  const loggedOut = document.querySelector('#syncLoggedOut');
  const loggedIn = document.querySelector('#syncLoggedIn');
  if (email) email.textContent = syncUser?.email || '';
  if (loggedOut) loggedOut.hidden = Boolean(syncUser);
  if (loggedIn) loggedIn.hidden = !syncUser;
  setSyncStatus(syncUser ? 'Sincronizado' : 'Somente neste aparelho', syncUser ? 'saved' : 'local');
}

function openSyncDialog() {
  updateAccountView();
  document.querySelector('#syncDialog')?.showModal();
}

function closeSyncDialog() {
  document.querySelector('#syncDialog')?.close();
}

function openConflictDialog() {
  document.querySelector('#syncConflictDialog')?.showModal();
}

async function resolveConflict(useRemote) {
  const dialog = document.querySelector('#syncConflictDialog');
  try {
    if (useRemote) {
      const row = await fetchRemoteRow();
      if (!row) throw new Error('A versão remota não foi encontrada.');
      remoteRevision = Number(row.revision || 0);
      await applyRemotePayload(row.payload);
      toast('Versão da nuvem carregada.');
    } else {
      const row = await fetchRemoteRow();
      remoteRevision = Number(row?.revision || 0);
      await updateRemoteRow({ force: true });
      toast('Esta versão substituiu a versão da nuvem.');
    }
    syncConflict = false;
    setSyncStatus('Sincronizado', 'saved');
    dialog?.close();
  } catch (error) {
    toast(error.message);
  }
}

function injectSyncInterface() {
  const actions = document.querySelector('.topbarActions');
  if (actions && !document.querySelector('#syncAccountBtn')) {
    const status = document.createElement('span');
    status.id = 'cloudSyncStatus';
    status.className = 'cloudSyncStatus';
    status.textContent = 'Iniciando...';
    const button = document.createElement('button');
    button.id = 'syncAccountBtn';
    button.className = 'ghost';
    button.type = 'button';
    button.textContent = 'Conectar';
    button.addEventListener('click', openSyncDialog);
    actions.prepend(button);
    actions.prepend(status);
  }

  if (!document.querySelector('#syncDialog')) {
    document.body.insertAdjacentHTML('beforeend', `
      <dialog id="syncDialog" class="syncDialog">
        <form method="dialog" class="syncDialogClose"><button aria-label="Fechar">×</button></form>
        <div id="syncLoggedOut">
          <span class="eyebrow">SINCRONIZAÇÃO SEGURA</span>
          <h2>Acesse seus processos em qualquer aparelho</h2>
          <p>Entre ou crie uma conta. Na primeira conexão, a base deste aparelho será enviada ao Supabase.</p>
          <form id="syncAuthForm" class="syncAuthForm">
            <label>E-mail<input id="syncEmail" type="email" autocomplete="email" required></label>
            <label>Senha<input id="syncPassword" type="password" autocomplete="current-password" minlength="8" required></label>
            <div class="syncActions">
              <button class="primary" type="submit">Entrar</button>
              <button id="syncSignUp" class="secondary" type="button">Criar conta</button>
            </div>
            <div id="syncAuthMessage" class="status" aria-live="polite"></div>
          </form>
        </div>
        <div id="syncLoggedIn" hidden>
          <span class="eyebrow">CONTA CONECTADA</span>
          <h2 id="syncUserEmail"></h2>
          <p>Processos, versões, checklists e andamento são sincronizados. Screenshots continuam somente neste aparelho nesta fase de teste.</p>
          <div class="syncActions">
            <button id="syncNow" class="primary" type="button">Sincronizar agora</button>
            <button id="syncSignOut" class="secondary" type="button">Sair da conta</button>
          </div>
        </div>
      </dialog>
      <dialog id="syncConflictDialog" class="syncDialog">
        <span class="eyebrow">CONFLITO DE VERSÕES</span>
        <h2>Outra máquina salvou dados mais recentes</h2>
        <p>Escolha qual cópia deve prevalecer. Nenhuma decisão será tomada automaticamente.</p>
        <div class="syncActions vertical">
          <button id="useRemoteVersion" class="primary" type="button">Usar versão da nuvem</button>
          <button id="useLocalVersion" class="danger" type="button">Substituir pela versão deste aparelho</button>
        </div>
      </dialog>
    `);
  }

  document.querySelector('#syncAuthForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = document.querySelector('#syncAuthMessage');
    message.textContent = 'Entrando...';
    try {
      await signIn(document.querySelector('#syncEmail').value.trim(), document.querySelector('#syncPassword').value);
      message.textContent = '';
      closeSyncDialog();
    } catch (error) {
      message.textContent = error.message;
    }
  });
  document.querySelector('#syncSignUp')?.addEventListener('click', async () => {
    const email = document.querySelector('#syncEmail').value.trim();
    const password = document.querySelector('#syncPassword').value;
    const message = document.querySelector('#syncAuthMessage');
    if (!email || password.length < 8) {
      message.textContent = 'Informe um e-mail válido e uma senha com pelo menos 8 caracteres.';
      return;
    }
    message.textContent = 'Criando conta...';
    try {
      const connected = await signUp(email, password);
      message.textContent = connected
        ? 'Conta criada e conectada.'
        : 'Conta criada. Confirme o e-mail recebido e depois entre.';
      if (connected) closeSyncDialog();
    } catch (error) {
      message.textContent = error.message;
    }
  });
  document.querySelector('#syncNow')?.addEventListener('click', async () => {
    await pushRemote();
    closeSyncDialog();
  });
  document.querySelector('#syncSignOut')?.addEventListener('click', async () => {
    await signOut();
    closeSyncDialog();
  });
  document.querySelector('#useRemoteVersion')?.addEventListener('click', () => resolveConflict(true));
  document.querySelector('#useLocalVersion')?.addEventListener('click', () => resolveConflict(false));
  window.addEventListener('online', () => {
    setSyncStatus(syncUser ? 'Reconectando...' : 'Somente neste aparelho', syncUser ? 'saving' : 'local');
    if (syncUser) pushRemote();
  });
  window.addEventListener('offline', () => setSyncStatus('Salvo neste aparelho', 'waiting'));
}

injectSyncInterface();
