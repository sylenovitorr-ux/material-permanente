'use strict';

const DB_NAME = 'material-permanente-v57';
const DB_VERSION = 1;
const STORE = 'state';
let db;
let appState = { processes: [], gallery: [], pdf: null, appVersion: 'V63', activeVersionId: null };
let versions = [];
let draftProcesses = [];
let deferredPrompt = null;
let organizeMode = false;
let selectedProcessIds = new Set();
let draggedProcessId = null;
let suppressProcessClick = false;
let processChecklistData = {};
let processStepImages = {};
let processRuns = {};
let activeRunId = null;
let editorStepDraft = [];
let activeProcessChecklistId = null;
let activeStepOrganizerId = null;
let draggedStepIndex = null;
let baseUpdatesAdded = 0;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clone = (v) => JSON.parse(JSON.stringify(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const normalize = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const lines = (id) => ($(id).value || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const STOP_WORDS = new Set(['a','o','as','os','um','uma','de','da','do','das','dos','e','em','no','na','nos','nas','para','por','com','que','qual','como','quando','onde','meu','minha','fazer','faco','devo']);
const QUESTION_SYNONYMS = {
  nf: ['nota fiscal', 'liquidada', 'liquidacao'],
  nota: ['nf', 'documento de origem'],
  guia: ['saldo em transito', 'apropriacao', 'remessa'],
  transito: ['guia', 'apropriacao', 'bens moveis a receber'],
  fechar: ['fechamento', 'rma', 'rmb', 'balancete'],
  fechamento: ['rma', 'rmb', 'depreciacao', 'ajuste', 'conformidade'],
  baixa: ['descarga', 'recolhimento', 'inservivel'],
  excluir: ['corrigir', 'movimento errado'],
  patrimonio: ['ficha', 'id migracao', 'material permanente'],
  diferenca: ['ajuste', 'siafi x siscofis', 'confronto'],
};

const FLOW_STAGES = [
  { id: 'receber', icon: '📥', title: 'Recebimento', subtitle: 'Receber NF, guia ou documento e conferir assinatura, data, valor e material.', systems: ['Documento físico', 'SPED'], processIds: ['recebimento_nf_guia', 'trem_crem'] },
  { id: 'liquidar', icon: '🧾', title: 'Verificação da liquidação', subtitle: 'Confirmar no SIAFI se a nota fiscal foi liquidada e localizar a documentação.', systems: ['SIAFI'], processIds: ['nf_entrada_liquidada'] },
  { id: 'apropriar', icon: '🚚', title: 'Entrada e apropriação', subtitle: 'Registrar a entrada, apropriar guia e eliminar o saldo em trânsito.', systems: ['SIAFI', 'SISCOFIS'], processIds: ['saldo_transito', 'nf_entrada_liquidada'] },
  { id: 'cadastrar', icon: '🏷️', title: 'Cadastro e identificação', subtitle: 'Criar ou conferir ficha, patrimônio, ID de migração e situação do material.', systems: ['SISCOFIS'], processIds: ['fichas', 'consultar_material', 'verificar_inconsistencia_ficha', 'processo_atualizacao_mudar_ficha_id_migracao', 'criar_espelho_guias_documentos'] },
  { id: 'distribuir', icon: '🔁', title: 'Distribuição e movimentação', subtitle: 'Distribuir, transferir e manter conta, subitem, dependência e patrimônio corretos.', systems: ['SISCOFIS'], processIds: ['transferencia_siscofis', 'erro_movimento', 'criar_guia_transferencia_entre_om', 'excluir_patrimonios_guia_espelho'] },
  { id: 'controlar', icon: '📅', title: 'Controle durante o mês', subtitle: 'Conferir boletins, NF, saldo em trânsito, fichas e pendências semanalmente.', systems: ['SISCOFIS', 'SIAFI', 'BADM/BAAR'], processIds: ['rotina_semanal_material_permanente', 'boletim_administrativo', 'fechamento_semanal', 'verificar_inconsistencia_ficha'] },
  { id: 'saida', icon: '♻️', title: 'Recolhimento e saída', subtitle: 'Recolher, examinar e descarregar o bem, mantendo documento e baixa rastreáveis.', systems: ['SISCOFIS', 'SPED', 'BADM/BAAR'], processIds: ['descarga_refatorada', 'trem_crem'] },
  { id: 'bloquear', icon: '🔒', title: 'Pré-fechamento', subtitle: 'Avisar os setores, bloquear novos movimentos e organizar as pendências.', systems: ['SISCOFIS'], processIds: ['pre_fechamento_siscofis', 'fechamento_mes_fluxo_completo'] },
  { id: 'relatorios', icon: '📄', title: 'Gerar relatórios', subtitle: 'Emitir RMA/RMB e reunir os saldos patrimoniais do mês.', systems: ['SISCOFIS'], processIds: ['rma_rmb', 'fechamento_mes_fluxo_completo'] },
  { id: 'conciliar', icon: '⚖️', title: 'Conciliar e ajustar', subtitle: 'Comparar SIAFI e SISCOFIS, tratar diferenças, depreciação e unificação.', systems: ['SIAFI', 'SISCOFIS'], processIds: ['ajuste_siafi_siscofis', 'unificacao_patrimonial', 'depreciacao', 'fechamento_mes_fluxo_completo'] },
  { id: 'arquivar', icon: '📎', title: 'Conformidade e arquivo', subtitle: 'Vincular PA, BADM/BAAR e documentos, registrar conformidade e arquivar.', systems: ['SIAFI', 'BADM/BAAR', 'Arquivo'], processIds: ['registro_conformidade_pa_arquivo', 'arquivos_mes', 'fechamento_mes_fluxo_completo'] },
];

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function updateSaveIndicator(label = 'Dados salvos') {
  const indicator = $('#saveIndicator');
  if (!indicator) return;
  indicator.textContent = label;
  indicator.classList.toggle('saving', label !== 'Dados salvos');
}

function markSaving() {
  updateSaveIndicator('Salvando...');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbSet(key, value) {
  return new Promise((resolve, reject) => {
    markSaving();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => {
      updateSaveIndicator();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function loadBaseData() {
  const response = await fetch('./dados.json');
  if (!response.ok) throw new Error('Não foi possível carregar dados.json');
  return response.json();
}

function syncNewBaseProcesses(state, base) {
  const savedIds = new Set();
  const collectIds = (items) => (items || []).forEach((process) => {
    savedIds.add(process.id);
    if (Array.isArray(process.children)) collectIds(process.children);
  });
  collectIds(state.processes);
  const missing = (base.processes || []).filter((process) => !savedIds.has(process.id));
  if (missing.length) state.processes.push(...clone(missing));
  state.appVersion = base.appVersion || state.appVersion;
  state.baseUpdatedAt = base.updatedAt || state.baseUpdatedAt;
  return missing;
}

function baseStateFromData(base) {
  return {
    appVersion: base.appVersion,
    updatedAt: base.updatedAt,
    baseUpdatedAt: base.baseUpdatedAt || base.updatedAt,
    baseRevision: base.baseRevision || null,
    pdf: base.pdf,
    processes: clone(base.processes || []),
    activeVersionId: base.seedActiveVersionId || null
  };
}

function mergeSeedVersions(target, seedVersions) {
  if (!Array.isArray(seedVersions)) return target;
  const known = new Set(target.map((version) => version.id));
  seedVersions.forEach((version) => {
    if (!known.has(version.id)) {
      target.push(clone(version));
      known.add(version.id);
    }
  });
  return target.slice(-40);
}

async function initializeData() {
  db = await openDb();
  const base = await loadBaseData();
  const savedState = await dbGet('appState');
  const savedVersions = await dbGet('versions');
  const savedProcessChecklist = await dbGet('processChecklistData');
  processChecklistData = savedProcessChecklist && typeof savedProcessChecklist === 'object' ? savedProcessChecklist : {};
  const savedStepImages = await dbGet('processStepImages');
  processStepImages = savedStepImages && typeof savedStepImages === 'object' ? savedStepImages : {};
  const savedRuns = await dbGet('processRuns');
  processRuns = savedRuns && typeof savedRuns === 'object' ? savedRuns : {};
  if (savedState && Array.isArray(savedState.processes)) {
    appState = savedState;
    versions = Array.isArray(savedVersions) ? savedVersions : [];
    const publishedRevisionChanged = Boolean(base.baseRevision && appState.baseRevision !== base.baseRevision);
    const samePublishedProcesses = publishedRevisionChanged
      && JSON.stringify(appState.processes) === JSON.stringify(base.processes || []);
    if (publishedRevisionChanged && !samePublishedProcesses) {
      const previousVersionId = uid();
      versions.push({
        id: previousVersionId,
        name: `Antes da atualização ${base.appVersion || ''}`.trim(),
        createdAt: new Date().toISOString(),
        note: 'Estado anterior preservado automaticamente antes de aplicar o backup publicado.',
        processes: clone(appState.processes)
      });
      versions = mergeSeedVersions(versions, base.seedVersions);
      const publishedVersionId = uid();
      appState = { ...baseStateFromData(base), activeVersionId: publishedVersionId };
      versions.push({
        id: publishedVersionId,
        name: `Backup publicado ${base.appVersion || ''}`.trim(),
        createdAt: new Date().toISOString(),
        note: `Base atualizada a partir do backup exportado em ${base.publishedBackupExportedAt || 'data não informada'}.`,
        processes: clone(appState.processes)
      });
      if (versions.length > 40) versions = versions.slice(-40);
      baseUpdatesAdded = 0;
      await persist();
    } else {
      if (publishedRevisionChanged) {
        Object.assign(appState, {
          appVersion: base.appVersion || appState.appVersion,
          baseUpdatedAt: base.baseUpdatedAt || base.updatedAt || appState.baseUpdatedAt,
          baseRevision: base.baseRevision
        });
        versions = mergeSeedVersions(versions, base.seedVersions);
      }
      const added = syncNewBaseProcesses(appState, base);
      baseUpdatesAdded = added.length;
      if (added.length) {
        const versionId = uid();
        appState.activeVersionId = versionId;
        versions.push({
          id: versionId,
          name: `Atualização automática ${base.appVersion || ''}`.trim(),
          createdAt: new Date().toISOString(),
          note: `${added.length} processo${added.length === 1 ? '' : 's'} novo${added.length === 1 ? '' : 's'} incorporado${added.length === 1 ? '' : 's'} sem apagar os dados importados.`,
          processes: clone(appState.processes)
        });
        if (versions.length > 40) versions = versions.slice(-40);
      }
      if (publishedRevisionChanged || added.length) await persist();
    }
  } else {
    const seededVersions = Array.isArray(base.seedVersions) ? clone(base.seedVersions) : [];
    const versionId = base.seedActiveVersionId || uid();
    appState = { ...baseStateFromData(base), activeVersionId: versionId };
    versions = seededVersions.length ? seededVersions : [{
      id: versionId,
      name: 'Base original preservada',
      createdAt: new Date().toISOString(),
      note: 'Primeira versão importada do material anterior.',
      processes: clone(base.processes)
    }];
    processChecklistData = base.seedProcessChecklistData && typeof base.seedProcessChecklistData === 'object'
      ? clone(base.seedProcessChecklistData) : {};
    processStepImages = base.seedProcessStepImages && typeof base.seedProcessStepImages === 'object'
      ? clone(base.seedProcessStepImages) : {};
    processRuns = base.seedProcessRuns && typeof base.seedProcessRuns === 'object'
      ? clone(base.seedProcessRuns) : {};
    await persist();
  }
  draftProcesses = clone(appState.processes);
}

async function persist() {
  await dbSet('appState', appState);
  await dbSet('versions', versions);
  await dbSet('processChecklistData', processChecklistData);
  await dbSet('processStepImages', processStepImages);
  await dbSet('processRuns', processRuns);
  updateSaveIndicator();
}

function switchView(id) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === id));
  if (id === 'editor') renderEditorSelect();
  if (id === 'historico') renderHistory();
  if (id === 'mapa') renderMindMap();
  if (id === 'andamento') renderRunningDashboard();
  if (id === 'backup') renderStorageUsage();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function sourceInfo(p) {
  const text = normalize(`${p.origin || ''} ${p.category || ''}`);
  if (text.includes('rae')) return { label: 'Norma oficial', className: 'sourceOfficial' };
  if (text.includes('pdf') || text.includes('base oficial') || text.includes('caderno')) return { label: 'Referência oficial', className: 'sourceGuidance' };
  return { label: 'Rotina interna', className: 'sourceLocal' };
}

function flattenProcesses(processes = appState.processes) {
  return processes.flatMap((process) => process.isGroup && Array.isArray(process.children)
    ? flattenProcesses(process.children)
    : [process]);
}

function findProcessById(id, processes = appState.processes) {
  for (const process of processes) {
    if (process.id === id) return process;
    if (process.isGroup && Array.isArray(process.children)) {
      const found = findProcessById(id, process.children);
      if (found) return found;
    }
  }
  return null;
}

function renderStats() {
  const processCount = flattenProcesses().length;
  $('#statProcesses').textContent = processCount;
  $('#statVersions').textContent = versions.length;
  const baseCount = versions[0]?.processes?.length || appState.processes.length;
  $('#statEdited').textContent = Math.max(0, processCount - baseCount) + Math.max(0, versions.length - 1);
}

function renderCategories() {
  const current = $('#categoryFilter').value;
  const cats = [...new Set(flattenProcesses().map((p) => p.category).filter(Boolean))].sort();
  $('#categoryFilter').innerHTML = '<option value="">Todas as categorias</option>' + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (cats.includes(current)) $('#categoryFilter').value = current;
}

function runsForProcess(processId) {
  return Object.values(processRuns).filter((run) => run.processId === processId);
}

function activeRunForProcess(processId) {
  return runsForProcess(processId)
    .filter((run) => run.status !== 'completed' && run.status !== 'cancelled')
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null;
}

function runProgress(run, process = findProcessById(run?.processId)) {
  const steps = process?.steps || [];
  const completed = steps.filter((step) => ['done', 'na'].includes(run?.steps?.[step]?.status)).length;
  return {
    completed,
    total: steps.length,
    percent: steps.length ? Math.round((completed / steps.length) * 100) : 0
  };
}

function renderProcesses() {
  const term = normalize($('#searchInput').value);
  const cat = $('#categoryFilter').value;
  const list = appState.processes.filter((p) => {
    const children = p.isGroup ? flattenProcesses(p.children || []) : [p];
    const matchCat = !cat || p.category === cat || children.some((child) => child.category === cat);
    const matchTerm = !term || normalize(JSON.stringify(p)).includes(term);
    return matchCat && matchTerm;
  });
  $('#processGrid').innerHTML = list.length ? list.map((p) => {
    const source = sourceInfo(p);
    const selected = selectedProcessIds.has(p.id);
    const memberCount = p.isGroup ? flattenProcesses(p.children || []).length : 0;
    const activeRun = p.isGroup ? null : activeRunForProcess(p.id);
    const progress = activeRun ? runProgress(activeRun, p) : null;
    return `
    <article class="card processCard ${organizeMode ? 'organizing' : ''} ${selected ? 'selected' : ''} ${p.isGroup ? 'groupCard' : ''}" data-id="${esc(p.id)}">
      ${organizeMode ? `<div class="organizeCardTools">
        <button type="button" class="selectProcess ${selected ? 'selected' : ''}" data-select-id="${esc(p.id)}" aria-label="${selected ? 'Remover da seleção' : 'Selecionar processo'}">${selected ? '✓ Selecionado' : '＋ Selecionar'}</button>
        <button type="button" draggable="true" class="dragHandle" data-process-drag-handle="${esc(p.id)}" aria-label="Arrastar ${esc(p.title)} para mudar a ordem">⠿ Arrastar bloco</button>
        <span class="moveButtons">
          <button type="button" data-move-id="${esc(p.id)}" data-direction="-1" aria-label="Mover para cima" title="Mover para cima">↑</button>
          <button type="button" data-move-id="${esc(p.id)}" data-direction="1" aria-label="Mover para baixo" title="Mover para baixo">↓</button>
        </span>
      </div>` : ''}
      <div class="cardMeta"><span class="badge">${esc(p.category || 'Processo')}</span><span class="sourceBadge ${source.className}">${source.label}</span></div>
      <h3>${esc(p.icon || '📌')} ${esc(p.title)}</h3>
      <p>${esc(p.goal || '')}</p>
      ${p.isGroup ? `<span class="groupCount">${memberCount} processos reunidos</span>` : ''}
      ${progress ? `<div class="cardRunProgress"><span><strong>${progress.percent}%</strong> em andamento</span><div class="progressTrack"><i style="width:${progress.percent}%"></i></div></div>` : ''}
      <div class="processCardActions">
        <button type="button" class="openProcessAction" data-open-process="${esc(p.id)}">${p.isGroup ? 'Abrir bloco' : 'Abrir processo'}</button>
        ${p.isGroup ? '' : `
          <button type="button" class="runProcessAction" data-run-process="${esc(p.id)}">${activeRun ? '▶ Continuar' : '▶ Executar'}</button>
          <button type="button" data-open-checklist="${esc(p.id)}">✓ Checklist</button>
          <button type="button" data-open-step-order="${esc(p.id)}">↕ Reordenar passos</button>
        `}
      </div>
    </article>`;
  }).join('') : '<article class="card">Nenhum processo encontrado.</article>';
  $$('.processCard').forEach((card) => {
    card.addEventListener('click', () => {
      if (suppressProcessClick) return;
      if (organizeMode) toggleProcessSelection(card.dataset.id);
      else openProcess(card.dataset.id);
    });
    if (organizeMode) {
      card.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (draggedProcessId && draggedProcessId !== card.dataset.id) card.classList.add('dragTarget');
      });
      card.addEventListener('dragleave', () => card.classList.remove('dragTarget'));
      card.addEventListener('drop', async (event) => {
        event.preventDefault();
        card.classList.remove('dragTarget');
        const sourceId = draggedProcessId || event.dataTransfer.getData('text/plain');
        suppressProcessClick = true;
        await handleProcessDrop(sourceId, card.dataset.id);
        setTimeout(() => { suppressProcessClick = false; }, 0);
      });
    }
  });
  $$('[data-open-process]').forEach((button) => button.onclick = (event) => {
    event.stopPropagation();
    openProcess(button.dataset.openProcess);
  });
  $$('[data-open-checklist]').forEach((button) => button.onclick = (event) => {
    event.stopPropagation();
    activeProcessChecklistId = button.dataset.openChecklist;
    activeStepOrganizerId = null;
    openProcess(button.dataset.openChecklist);
  });
  $$('[data-open-step-order]').forEach((button) => button.onclick = (event) => {
    event.stopPropagation();
    activeStepOrganizerId = button.dataset.openStepOrder;
    activeProcessChecklistId = null;
    openProcess(button.dataset.openStepOrder);
  });
  $$('[data-run-process]').forEach((button) => button.onclick = (event) => {
    event.stopPropagation();
    startOrContinueRun(button.dataset.runProcess);
  });
  $$('.selectProcess').forEach((button) => button.onclick = (event) => {
    event.stopPropagation();
    toggleProcessSelection(button.dataset.selectId);
  });
  $$('[data-move-id]').forEach((button) => button.onclick = async (event) => {
    event.stopPropagation();
    await moveProcess(button.dataset.moveId, Number(button.dataset.direction));
  });
  bindDesktopProcessDragging();
  bindTouchProcessDragging();
  updateOrganizerControls();
}

function clearProcessDragTargets() {
  $$('.processCard').forEach((item) => item.classList.remove('dragTarget'));
}

function bindDesktopProcessDragging() {
  if (!organizeMode) return;
  $$('[data-process-drag-handle]').forEach((handle) => {
    handle.ondragstart = (event) => {
      event.stopPropagation();
      draggedProcessId = handle.dataset.processDragHandle;
      suppressProcessClick = true;
      handle.closest('.processCard')?.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedProcessId);
    };
    handle.ondragend = () => {
      handle.closest('.processCard')?.classList.remove('dragging');
      clearProcessDragTargets();
      draggedProcessId = null;
      setTimeout(() => { suppressProcessClick = false; }, 80);
    };
  });
}

async function handleProcessDrop(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  if (selectedProcessIds.has(sourceId) || selectedProcessIds.has(targetId)) {
    selectedProcessIds.add(sourceId);
    selectedProcessIds.add(targetId);
    renderProcesses();
    toast(`${selectedProcessIds.size} processos selecionados. Toque em “Criar bloco único”.`);
    return;
  }
  await reorderProcess(sourceId, targetId);
}

function bindTouchProcessDragging() {
  if (!organizeMode || !window.PointerEvent) return;
  $$('[data-process-drag-handle]').forEach((handle) => {
    handle.onpointerdown = (event) => {
      if (event.pointerType === 'mouse') return;
      event.preventDefault();
      event.stopPropagation();
      const sourceId = handle.dataset.processDragHandle;
      const sourceCard = handle.closest('.processCard');
      draggedProcessId = sourceId;
      suppressProcessClick = true;
      sourceCard.classList.add('dragging');
      handle.setPointerCapture?.(event.pointerId);

      const onMove = (moveEvent) => {
        moveEvent.preventDefault();
        clearProcessDragTargets();
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('.processCard');
        if (target && target.dataset.id !== sourceId) target.classList.add('dragTarget');
      };
      const onEnd = async (endEvent) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onCancel);
        const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest('.processCard');
        sourceCard.classList.remove('dragging');
        clearProcessDragTargets();
        draggedProcessId = null;
        if (target && target.dataset.id !== sourceId) await handleProcessDrop(sourceId, target.dataset.id);
        setTimeout(() => { suppressProcessClick = false; }, 80);
      };
      const onCancel = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onCancel);
        sourceCard.classList.remove('dragging');
        clearProcessDragTargets();
        draggedProcessId = null;
        setTimeout(() => { suppressProcessClick = false; }, 80);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onCancel);
    };
  });
}

function renderProcessSteps(p) {
  const checklistMode = activeProcessChecklistId === p.id;
  const organizerMode = activeStepOrganizerId === p.id;
  const checked = processChecklistData[p.id] || {};
  return (p.steps || []).map((step, index) => {
    const images = processStepImages[p.id]?.[step] || [];
    return `
    <div class="processStep ${checklistMode && checked[step] ? 'completed' : ''} ${organizerMode ? 'sortable' : ''}"
      data-process-step-index="${index}">
      ${checklistMode
        ? `<label class="processCheckControl" title="Marcar etapa">
            <input type="checkbox" data-process-check="${index}" ${checked[step] ? 'checked' : ''}>
            <span>✓</span>
          </label>`
        : `<span class="stepNum">${index + 1}</span>`}
      <div class="processStepContent">
        <span class="processStepText">${esc(step)}</span>
        <div class="stepImageActions">
          <button type="button" class="addStepImage" data-add-step-image="${index}">📷 Adicionar screenshot</button>
          <input type="file" accept="image/png,image/jpeg,image/webp" data-step-image-input="${index}" hidden>
          ${images.length ? `<span>${images.length} imagem${images.length === 1 ? '' : 'ns'}</span>` : ''}
        </div>
        ${images.length ? `<div class="stepImageGallery">${images.map((image) => `
          <figure class="stepImageCard">
            <button type="button" class="stepImagePreview" data-view-step-image="${esc(image.id)}" data-view-process="${esc(p.id)}" data-view-step="${index}">
              <img src="${esc(image.dataUrl)}" alt="${esc(image.caption || `Screenshot da etapa ${index + 1}`)}">
            </button>
            <figcaption>${esc(image.caption || image.name || 'Screenshot')}</figcaption>
            <div class="imageCardActions">
              <button type="button" data-annotate-step-image="${esc(image.id)}" data-annotate-process="${esc(p.id)}" data-annotate-step="${index}">Marcar/ocultar</button>
              <button type="button" class="removeStepImage" data-remove-step-image="${esc(image.id)}" data-remove-process="${esc(p.id)}" data-remove-step="${index}" aria-label="Excluir imagem">Excluir</button>
            </div>
          </figure>`).join('')}</div>` : ''}
      </div>
      ${organizerMode ? `<span class="stepOrderTools">
        <button type="button" draggable="true" class="stepDragHandle" data-step-drag-handle="${index}" aria-label="Arrastar etapa ${index + 1}">⠿ Arrastar</button>
        <button type="button" data-step-move="${index}" data-step-direction="-1" aria-label="Mover etapa para cima" title="Subir etapa">↑ Subir</button>
        <button type="button" data-step-move="${index}" data-step-direction="1" aria-label="Mover etapa para baixo" title="Descer etapa">↓ Descer</button>
      </span>` : ''}
    </div>`;
  }).join('');
}

function processChecklistProgress(p) {
  const steps = p.steps || [];
  const checked = processChecklistData[p.id] || {};
  const completed = steps.filter((step) => checked[step]).length;
  const percent = steps.length ? Math.round((completed / steps.length) * 100) : 0;
  return { completed, total: steps.length, percent };
}

function bindProcessDetailTools(p) {
  const checklistMode = activeProcessChecklistId === p.id;
  const organizerMode = activeStepOrganizerId === p.id;
  $('#toggleProcessChecklist').onclick = () => {
    activeProcessChecklistId = checklistMode ? null : p.id;
    activeStepOrganizerId = null;
    openProcess(p.id, false);
  };
  $('#toggleStepOrganizer').onclick = () => {
    activeStepOrganizerId = organizerMode ? null : p.id;
    activeProcessChecklistId = null;
    openProcess(p.id, false);
  };
  if (checklistMode) {
    $('#clearProcessChecklist').onclick = () => clearProcessChecklist(p.id);
    $$('[data-process-check]').forEach((input) => input.onchange = () => {
      toggleProcessChecklistStep(p.id, Number(input.dataset.processCheck), input.checked);
    });
  }
  if (organizerMode) {
    $$('[data-process-step-index]').forEach((row) => {
      row.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (draggedStepIndex !== null && draggedStepIndex !== Number(row.dataset.processStepIndex)) row.classList.add('dragTarget');
      });
      row.addEventListener('dragleave', () => row.classList.remove('dragTarget'));
      row.addEventListener('drop', async (event) => {
        event.preventDefault();
        const sourceIndex = draggedStepIndex ?? Number(event.dataTransfer.getData('text/plain'));
        await reorderProcessStep(p.id, sourceIndex, Number(row.dataset.processStepIndex));
      });
    });
    bindDesktopStepDragging();
    $$('[data-step-move]').forEach((button) => button.onclick = () => {
      moveProcessStep(p.id, Number(button.dataset.stepMove), Number(button.dataset.stepDirection));
    });
    bindTouchStepDragging(p.id);
  }
  bindStepImageTools(p, $('#processDetail'));
}

function bindDesktopStepDragging() {
  $$('[data-step-drag-handle]').forEach((handle) => {
    handle.ondragstart = (event) => {
      draggedStepIndex = Number(handle.dataset.stepDragHandle);
      handle.closest('[data-process-step-index]')?.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(draggedStepIndex));
    };
    handle.ondragend = () => {
      draggedStepIndex = null;
      handle.closest('[data-process-step-index]')?.classList.remove('dragging');
      $$('[data-process-step-index]').forEach((item) => item.classList.remove('dragTarget'));
    };
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Formato de imagem não reconhecido.'));
    image.src = dataUrl;
  });
}

async function optimizeStepImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('Escolha uma imagem PNG, JPG ou WebP.');
  if (file.size > 15 * 1024 * 1024) throw new Error('A imagem deve ter no máximo 15 MB.');
  const original = await readFileAsDataUrl(file);
  const image = await loadImage(original);
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.84);
}

function stepImagesFor(processId, step) {
  processStepImages[processId] = processStepImages[processId] || {};
  processStepImages[processId][step] = processStepImages[processId][step] || [];
  return processStepImages[processId][step];
}

async function addStepImage(processId, stepIndex, file) {
  const process = findProcessById(processId);
  const step = process?.steps?.[stepIndex];
  if (!step || !file) return;
  const images = stepImagesFor(processId, step);
  if (images.length >= 10) {
    toast('Cada etapa aceita no máximo 10 imagens.');
    return;
  }
  try {
    toast('Preparando screenshot...');
    const dataUrl = await optimizeStepImage(file);
    const caption = prompt('Legenda da imagem (opcional):', file.name.replace(/\.[^.]+$/, ''))?.trim() || '';
    images.push({
      id: uid(),
      name: file.name,
      caption,
      dataUrl,
      createdAt: new Date().toISOString()
    });
    await dbSet('processStepImages', processStepImages);
    refreshProcessSurface(processId);
    toast('Screenshot adicionado à etapa.');
  } catch (error) {
    toast(error.message);
  }
}

function showStepImage(processId, stepIndex, imageId) {
  const process = findProcessById(processId);
  const step = process?.steps?.[stepIndex];
  const image = step ? (processStepImages[processId]?.[step] || []).find((item) => item.id === imageId) : null;
  if (!image) return;
  const viewer = document.createElement('div');
  viewer.className = 'stepImageViewer';
  viewer.innerHTML = `
    <div class="stepImageViewerPanel">
      <button type="button" class="closeStepImage" aria-label="Fechar imagem">×</button>
      <img src="${esc(image.dataUrl)}" alt="${esc(image.caption || 'Screenshot da etapa')}">
      ${image.caption ? `<p>${esc(image.caption)}</p>` : ''}
    </div>`;
  viewer.onclick = (event) => {
    if (event.target === viewer || event.target.closest('.closeStepImage')) viewer.remove();
  };
  document.body.appendChild(viewer);
}

async function removeStepImage(processId, stepIndex, imageId) {
  const process = findProcessById(processId);
  const step = process?.steps?.[stepIndex];
  if (!step || !confirm('Excluir esta imagem da etapa?')) return;
  const images = processStepImages[processId]?.[step] || [];
  processStepImages[processId][step] = images.filter((image) => image.id !== imageId);
  if (!processStepImages[processId][step].length) delete processStepImages[processId][step];
  await dbSet('processStepImages', processStepImages);
  refreshProcessSurface(processId);
  toast('Imagem excluída.');
}

function refreshProcessSurface(processId) {
  const run = processRuns[activeRunId];
  if ($('#andamento')?.classList.contains('active') && run?.processId === processId) renderExecutionWorkspace();
  else openProcess(processId, false);
}

function bindStepImageTools(process, root = document) {
  root.querySelectorAll('[data-add-step-image]').forEach((button) => button.onclick = () => {
    const input = root.querySelector(`[data-step-image-input="${button.dataset.addStepImage}"]`);
    input?.click();
  });
  root.querySelectorAll('[data-step-image-input]').forEach((input) => input.onchange = async () => {
    const file = input.files?.[0];
    await addStepImage(process.id, Number(input.dataset.stepImageInput), file);
    input.value = '';
  });
  root.querySelectorAll('[data-view-step-image]').forEach((button) => button.onclick = () => {
    showStepImage(button.dataset.viewProcess, Number(button.dataset.viewStep), button.dataset.viewStepImage);
  });
  root.querySelectorAll('[data-remove-step-image]').forEach((button) => button.onclick = () => {
    removeStepImage(button.dataset.removeProcess, Number(button.dataset.removeStep), button.dataset.removeStepImage);
  });
  bindImageAnnotationButtons(root);
}

function bindImageAnnotationButtons(root = document) {
  root.querySelectorAll('[data-annotate-step-image]').forEach((button) => button.onclick = () => {
    openImageAnnotator(
      button.dataset.annotateProcess,
      Number(button.dataset.annotateStep),
      button.dataset.annotateStepImage
    );
  });
}

async function openImageAnnotator(processId, stepIndex, imageId) {
  const process = findProcessById(processId);
  const step = process?.steps?.[stepIndex];
  const imageRecord = step ? (processStepImages[processId]?.[step] || []).find((item) => item.id === imageId) : null;
  if (!imageRecord) return;
  const modal = document.createElement('div');
  modal.className = 'imageAnnotator';
  modal.innerHTML = `
    <div class="imageAnnotatorPanel">
      <div class="annotatorHeader">
        <div><strong>Marcar ou ocultar screenshot</strong><small>Use “Ocultar” para cobrir dados sensíveis antes do backup.</small></div>
        <button type="button" data-close-annotator aria-label="Fechar">×</button>
      </div>
      <div class="annotatorTools">
        <button type="button" class="active" data-annotation-tool="arrow">↗ Seta</button>
        <button type="button" data-annotation-tool="rectangle">▭ Retângulo</button>
        <button type="button" data-annotation-tool="redact">■ Ocultar</button>
        <button type="button" data-annotation-undo>↶ Desfazer</button>
        <label>Cor <input type="color" id="annotationColor" value="#e73323"></label>
      </div>
      <div class="annotatorCanvasWrap"><canvas id="annotationCanvas"></canvas></div>
      <div class="annotatorFooter">
        <button type="button" class="secondary" data-close-annotator>Cancelar</button>
        <button type="button" class="primary" id="saveAnnotation">Salvar marcações</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const canvas = modal.querySelector('#annotationCanvas');
  const ctx = canvas.getContext('2d');
  const source = await loadImage(imageRecord.dataUrl);
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(source.naturalWidth, source.naturalHeight));
  canvas.width = Math.round(source.naturalWidth * scale);
  canvas.height = Math.round(source.naturalHeight * scale);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  let tool = 'arrow';
  let drawing = false;
  let start = null;
  let before = null;
  const history = [canvas.toDataURL('image/webp', 0.86)];

  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
  };
  const drawArrow = (from, to, color) => {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = Math.max(18, canvas.width * 0.018);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(5, canvas.width * 0.004);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  };
  const drawShape = (from, to) => {
    const color = modal.querySelector('#annotationColor').value;
    if (tool === 'arrow') drawArrow(from, to, color);
    if (tool === 'rectangle') {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(5, canvas.width * 0.004);
      ctx.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
    }
    if (tool === 'redact') {
      ctx.fillStyle = '#111';
      ctx.fillRect(from.x, from.y, to.x - from.x, to.y - from.y);
    }
  };
  canvas.onpointerdown = (event) => {
    drawing = true;
    start = point(event);
    before = ctx.getImageData(0, 0, canvas.width, canvas.height);
    canvas.setPointerCapture?.(event.pointerId);
  };
  canvas.onpointermove = (event) => {
    if (!drawing) return;
    ctx.putImageData(before, 0, 0);
    drawShape(start, point(event));
  };
  canvas.onpointerup = (event) => {
    if (!drawing) return;
    drawing = false;
    ctx.putImageData(before, 0, 0);
    drawShape(start, point(event));
    history.push(canvas.toDataURL('image/webp', 0.86));
  };
  modal.querySelectorAll('[data-annotation-tool]').forEach((button) => button.onclick = () => {
    tool = button.dataset.annotationTool;
    modal.querySelectorAll('[data-annotation-tool]').forEach((item) => item.classList.toggle('active', item === button));
  });
  modal.querySelector('[data-annotation-undo]').onclick = async () => {
    if (history.length <= 1) return;
    history.pop();
    const previous = await loadImage(history[history.length - 1]);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(previous, 0, 0, canvas.width, canvas.height);
  };
  modal.querySelectorAll('[data-close-annotator]').forEach((button) => button.onclick = () => modal.remove());
  modal.querySelector('#saveAnnotation').onclick = async () => {
    imageRecord.dataUrl = canvas.toDataURL('image/webp', 0.86);
    imageRecord.annotatedAt = new Date().toISOString();
    await dbSet('processStepImages', processStepImages);
    modal.remove();
    refreshProcessSurface(processId);
    renderStorageUsage();
    toast('Marcações salvas no screenshot.');
  };
}

function bindTouchStepDragging(processId) {
  if (!window.PointerEvent) return;
  $$('[data-step-drag-handle]').forEach((handle) => {
    handle.onpointerdown = (event) => {
      if (event.pointerType === 'mouse') return;
      event.preventDefault();
      event.stopPropagation();
      const sourceIndex = Number(handle.dataset.stepDragHandle);
      const sourceRow = handle.closest('[data-process-step-index]');
      draggedStepIndex = sourceIndex;
      sourceRow.classList.add('dragging');
      handle.setPointerCapture?.(event.pointerId);

      const clearTargets = () => $$('[data-process-step-index]').forEach((item) => item.classList.remove('dragTarget'));
      const onMove = (moveEvent) => {
        moveEvent.preventDefault();
        clearTargets();
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('[data-process-step-index]');
        if (target && Number(target.dataset.processStepIndex) !== sourceIndex) target.classList.add('dragTarget');
      };
      const finish = async (endEvent) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', cancel);
        const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest('[data-process-step-index]');
        sourceRow.classList.remove('dragging');
        clearTargets();
        draggedStepIndex = null;
        if (target) await reorderProcessStep(processId, sourceIndex, Number(target.dataset.processStepIndex));
      };
      const cancel = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', cancel);
        sourceRow.classList.remove('dragging');
        clearTargets();
        draggedStepIndex = null;
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', cancel);
    };
  });
}

async function toggleProcessChecklistStep(processId, stepIndex, checked) {
  const process = findProcessById(processId);
  const step = process?.steps?.[stepIndex];
  if (!step) return;
  processChecklistData[processId] = processChecklistData[processId] || {};
  processChecklistData[processId][step] = checked;
  await dbSet('processChecklistData', processChecklistData);
  openProcess(processId, false);
}

async function clearProcessChecklist(processId) {
  const process = findProcessById(processId);
  if (!process || !confirm(`Limpar as marcações de "${process.title}"?`)) return;
  delete processChecklistData[processId];
  await dbSet('processChecklistData', processChecklistData);
  openProcess(processId, false);
  toast('Checklist do processo limpo.');
}

async function reorderProcessStep(processId, sourceIndex, targetIndex) {
  const process = findProcessById(processId);
  if (!process || sourceIndex === targetIndex || sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = process.steps.splice(sourceIndex, 1);
  process.steps.splice(targetIndex, 0, moved);
  appState.updatedAt = new Date().toISOString();
  draftProcesses = clone(appState.processes);
  await persist();
  openProcess(processId, false);
  toast('Ordem das etapas atualizada.');
}

async function moveProcessStep(processId, index, direction) {
  const process = findProcessById(processId);
  const target = index + direction;
  if (!process || target < 0 || target >= (process.steps || []).length) return;
  [process.steps[index], process.steps[target]] = [process.steps[target], process.steps[index]];
  appState.updatedAt = new Date().toISOString();
  draftProcesses = clone(appState.processes);
  await persist();
  openProcess(processId, false);
  toast('Etapa reposicionada.');
}

function openProcess(id, shouldScroll = true) {
  const p = findProcessById(id);
  if (!p) return;
  const source = sourceInfo(p);
  const detail = $('#processDetail');
  detail.hidden = false;
  if (p.isGroup) {
    const members = flattenProcesses(p.children || []);
    detail.innerHTML = `
      <div class="cardMeta"><span class="badge">Grupo de processos</span><span class="groupCount">${members.length} itens</span></div>
      <h2>${esc(p.icon || '📁')} ${esc(p.title)}</h2>
      <p>${esc(p.goal || '')}</p>
      <div class="groupMembers">
        ${members.map((member, index) => `<button class="groupMember" type="button" data-member-id="${esc(member.id)}">
          <span>${index + 1}</span><strong>${esc(member.icon || '📌')} ${esc(member.title)}</strong><small>${esc(member.category || '')}</small>
        </button>`).join('')}
      </div>
      <div class="actionRow" style="margin-top:14px">
        <button class="secondary" id="renameGroup" type="button">Renomear grupo</button>
        <button class="danger" id="ungroupProcesses" type="button">Desagrupar</button>
      </div>`;
    $$('.groupMember').forEach((button) => button.onclick = () => openProcess(button.dataset.memberId));
    $('#renameGroup').onclick = () => renameProcessGroup(p.id);
    $('#ungroupProcesses').onclick = () => ungroupProcesses(p.id);
    if (shouldScroll) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const isGroupedChild = !appState.processes.some((process) => process.id === id);
  const checklistMode = activeProcessChecklistId === p.id;
  const organizerMode = activeStepOrganizerId === p.id;
  const progress = processChecklistProgress(p);
  detail.innerHTML = `
    <div class="cardMeta"><span class="badge">${esc(p.category || '')}</span><span class="sourceBadge ${source.className}">${source.label}</span></div>
    <h2>${esc(p.icon || '📌')} ${esc(p.title)}</h2>
    <p>${esc(p.goal || '')}</p>
    ${p.warning ? `<div class="warning"><strong>Atenção:</strong> ${esc(p.warning)}</div>` : ''}
    <div class="processDetailTools">
      <button class="primary" id="executeThisProcess" type="button">▶ ${activeRunForProcess(p.id) ? 'Continuar execução' : 'Iniciar execução'}</button>
      <button class="${checklistMode ? 'primary' : 'secondary'}" id="toggleProcessChecklist" type="button">✓ ${checklistMode ? 'Fechar checklist' : 'Usar checklist'}</button>
      <button class="${organizerMode ? 'primary' : 'secondary'}" id="toggleStepOrganizer" type="button">↕ ${organizerMode ? 'Concluir organização' : 'Reorganizar etapas'}</button>
      ${checklistMode ? '<button class="danger" id="clearProcessChecklist" type="button">Limpar marcações</button>' : ''}
    </div>
    ${organizerMode ? '<div class="desktopReorderHelp"><strong>Reorganização ativa:</strong> no computador, arraste pela alça “⠿ Arrastar” e solte sobre a etapa desejada. Se preferir, use “↑ Subir” e “↓ Descer”. A nova ordem é salva automaticamente.</div>' : ''}
    <div class="stepImagePrivacy"><strong>📷 Screenshots por etapa:</strong> toque em “Adicionar screenshot”. As imagens ficam somente neste aparelho e entram no backup exportado. Antes de salvar, recorte ou oculte dados pessoais, credenciais e informações de acesso restrito.</div>
    ${checklistMode ? `<div class="processChecklistSummary">
      <strong>${progress.percent}%</strong>
      <span>${progress.completed} de ${progress.total} etapas concluídas</span>
      <div class="progressTrack"><i style="width:${progress.percent}%"></i></div>
    </div>` : ''}
    <h3>Passo a passo</h3>
    <div class="processSteps">${renderProcessSteps(p)}</div>
    ${(p.details || []).length ? `<h3>Observações</h3><ul>${p.details.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${(p.paths || []).length ? `<h3>Caminhos</h3><ul>${p.paths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${(p.accounts || []).length ? `<h3>Contas e referências</h3><p>${p.accounts.map((x) => `<span class="badge">${esc(x)}</span>`).join(' ')}</p>` : ''}
    ${p.copy ? `<h3>Modelo</h3><div class="warning">${esc(p.copy)}</div>` : ''}
    ${isGroupedChild
      ? '<div class="warning" style="margin-top:14px"><strong>Processo agrupado:</strong> desagrupe o bloco para editar este processo individualmente.</div>'
      : '<div class="actionRow" style="margin-top:14px"><button class="primary" id="editThis">Editar este processo</button></div>'}`;
  bindProcessDetailTools(p);
  $('#executeThisProcess').onclick = () => startOrContinueRun(p.id);
  if (!isGroupedChild) {
    $('#editThis').onclick = () => {
      switchView('editor');
      $('#editorSelect').value = id;
      loadEditorForm();
    };
  }
  if (shouldScroll) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function startOrContinueRun(processId, startIndex = null) {
  const process = findProcessById(processId);
  if (!process || process.isGroup) return;
  let run = activeRunForProcess(processId);
  if (!run) {
    const responsible = prompt('Responsável pela execução (opcional):', '')?.trim() || '';
    const reference = prompt('Referência do processo (opcional: guia, BADM, mês ou documento):', '')?.trim() || '';
    const id = `exec-${uid()}`;
    run = {
      id,
      processId,
      processTitle: process.title,
      responsible,
      reference,
      status: 'in_progress',
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      steps: {},
      generalNote: ''
    };
    processRuns[id] = run;
    await dbSet('processRuns', processRuns);
  }
  if (Number.isInteger(startIndex)) {
    run.currentIndex = Math.max(0, Math.min(startIndex, Math.max(0, (process.steps || []).length - 1)));
    run.updatedAt = new Date().toISOString();
    await dbSet('processRuns', processRuns);
  }
  activeRunId = run.id;
  switchView('andamento');
  renderExecutionWorkspace();
}

function runStatusLabel(run) {
  if (run.status === 'completed') return 'Concluído';
  if (run.status === 'cancelled') return 'Arquivado';
  return 'Em andamento';
}

function formatShortDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function renderRunningDashboard() {
  const container = $('#runningDashboard');
  if (!container) return;
  const runs = Object.values(processRuns).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const active = runs.filter((run) => run.status === 'in_progress');
  const finished = runs.filter((run) => run.status !== 'in_progress').slice(0, 8);
  const card = (run) => {
    const process = findProcessById(run.processId);
    const progress = runProgress(run, process);
    return `<article class="card runCard ${run.status}">
      <div class="runCardTop"><span class="runStatus">${runStatusLabel(run)}</span><strong>${progress.percent}%</strong></div>
      <h3>${esc(process?.icon || '📌')} ${esc(process?.title || run.processTitle || 'Processo')}</h3>
      <p>${run.reference ? `<b>${esc(run.reference)}</b> · ` : ''}${run.responsible ? `Responsável: ${esc(run.responsible)}` : 'Sem responsável informado'}</p>
      <div class="progressTrack"><i style="width:${progress.percent}%"></i></div>
      <small>${progress.completed} de ${progress.total} etapas · Atualizado ${formatShortDate(run.updatedAt)}</small>
      <div class="runCardActions">
        <button type="button" class="${run.status === 'in_progress' ? 'primary' : 'secondary'}" data-open-run="${esc(run.id)}">${run.status === 'in_progress' ? 'Continuar' : 'Revisar'}</button>
        ${run.status === 'in_progress' ? `<button type="button" class="danger" data-cancel-run="${esc(run.id)}">Arquivar</button>` : ''}
      </div>
    </article>`;
  };
  container.innerHTML = `
    <div class="runSectionHeading"><h2>Em andamento</h2><span>${active.length}</span></div>
    <div class="runGrid">${active.length ? active.map(card).join('') : '<article class="card emptyRun"><strong>Nenhum processo em andamento.</strong><span>Inicie pela lista de processos ou pelo botão acima.</span></article>'}</div>
    ${finished.length ? `<div class="runSectionHeading"><h2>Histórico recente</h2><span>${finished.length}</span></div><div class="runGrid compact">${finished.map(card).join('')}</div>` : ''}`;
  $$('[data-open-run]').forEach((button) => button.onclick = () => {
    activeRunId = button.dataset.openRun;
    renderExecutionWorkspace();
  });
  $$('[data-cancel-run]').forEach((button) => button.onclick = () => archiveRun(button.dataset.cancelRun));
  renderHomeRunning(active);
  if (activeRunId && processRuns[activeRunId]) renderExecutionWorkspace();
}

function renderHomeRunning(activeRuns = Object.values(processRuns).filter((run) => run.status === 'in_progress')) {
  const container = $('#homeRunning');
  if (!container) return;
  const recent = [...activeRuns].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 3);
  container.innerHTML = recent.length ? `<div class="card homeRunningCard">
    <div><span class="eyebrow">RETOMAR TRABALHO</span><h2>${recent.length} processo${recent.length === 1 ? '' : 's'} em andamento</h2></div>
    <div class="homeRunList">${recent.map((run) => {
      const process = findProcessById(run.processId);
      const progress = runProgress(run, process);
      return `<button type="button" data-home-run="${esc(run.id)}"><span>${esc(process?.icon || '📌')}</span><strong>${esc(process?.title || run.processTitle)}</strong><small>${progress.percent}% · ${esc(run.reference || 'Sem referência')}</small></button>`;
    }).join('')}</div>
  </div>` : '';
  $$('[data-home-run]').forEach((button) => button.onclick = () => {
    activeRunId = button.dataset.homeRun;
    switchView('andamento');
    renderExecutionWorkspace();
  });
}

function executionImageGallery(process, step, stepIndex) {
  const images = processStepImages[process.id]?.[step] || [];
  return `<div class="executionEvidence">
    <div class="stepImageActions">
      <button type="button" class="addStepImage" data-add-step-image="${stepIndex}">📷 Adicionar screenshot</button>
      <input type="file" accept="image/png,image/jpeg,image/webp" data-step-image-input="${stepIndex}" hidden>
      ${images.length ? `<span>${images.length} evidência${images.length === 1 ? '' : 's'}</span>` : ''}
    </div>
    ${images.length ? `<div class="stepImageGallery">${images.map((image) => `
      <figure class="stepImageCard">
        <button type="button" class="stepImagePreview" data-view-step-image="${esc(image.id)}" data-view-process="${esc(process.id)}" data-view-step="${stepIndex}">
          <img src="${esc(image.dataUrl)}" alt="${esc(image.caption || `Screenshot da etapa ${stepIndex + 1}`)}">
        </button>
        <figcaption>${esc(image.caption || image.name || 'Screenshot')}</figcaption>
        <div class="imageCardActions">
          <button type="button" data-annotate-step-image="${esc(image.id)}" data-annotate-process="${esc(process.id)}" data-annotate-step="${stepIndex}">Marcar/ocultar</button>
          <button type="button" class="removeStepImage" data-remove-step-image="${esc(image.id)}" data-remove-process="${esc(process.id)}" data-remove-step="${stepIndex}">Excluir</button>
        </div>
      </figure>`).join('')}</div>` : ''}
  </div>`;
}

function renderExecutionWorkspace() {
  const workspace = $('#executionWorkspace');
  const run = processRuns[activeRunId];
  if (!workspace || !run) {
    if (workspace) workspace.hidden = true;
    return;
  }
  const process = findProcessById(run.processId);
  if (!process) {
    workspace.hidden = false;
    workspace.innerHTML = '<div class="warning">O processo desta execução não está disponível na versão atual.</div>';
    return;
  }
  const steps = process.steps || [];
  run.currentIndex = Math.max(0, Math.min(run.currentIndex || 0, Math.max(0, steps.length - 1)));
  const step = steps[run.currentIndex] || 'Processo sem etapas cadastradas.';
  const stepState = run.steps?.[step] || {};
  const progress = runProgress(run, process);
  const meta = process.stepMeta?.[step] || {};
  workspace.hidden = false;
  workspace.innerHTML = `
    <div class="executionTop">
      <button type="button" class="secondary" id="backToRuns">← Painel</button>
      <div><span class="eyebrow">EXECUÇÃO ATIVA</span><h2>${esc(process.icon || '📌')} ${esc(process.title)}</h2><p>${esc(run.reference || 'Sem referência informada')}</p></div>
      <strong class="executionPercent">${progress.percent}%</strong>
    </div>
    <div class="executionMeta">
      <label>Responsável<input id="runResponsible" value="${esc(run.responsible || '')}" placeholder="Nome do responsável"></label>
      <label>Referência<input id="runReference" value="${esc(run.reference || '')}" placeholder="Guia, BADM, mês ou documento"></label>
      <span>Iniciado em ${formatShortDate(run.startedAt)}</span>
    </div>
    <div class="progressTrack executionProgress"><i style="width:${progress.percent}%"></i></div>
    <div class="executionLayout">
      <aside class="executionRail">
        ${steps.map((item, index) => {
          const state = run.steps?.[item]?.status || '';
          return `<button type="button" class="${index === run.currentIndex ? 'current' : ''} ${state}" data-go-run-step="${index}"><span>${state === 'done' ? '✓' : state === 'na' ? '—' : index + 1}</span><small>${esc(item)}</small></button>`;
        }).join('')}
      </aside>
      <div class="executionCurrent">
        <div class="currentStepHeader"><span>ETAPA ${run.currentIndex + 1} DE ${steps.length}</span><span class="stepStateBadge ${stepState.status || ''}">${stepState.status === 'done' ? 'Concluída' : stepState.status === 'na' ? 'Não se aplica' : 'Pendente'}</span></div>
        <h2>${esc(step)}</h2>
        ${meta.type === 'decision' ? `<div class="decisionCard"><strong>Decisão</strong><div><span>SIM → ${esc(meta.yes || 'Prosseguir')}</span><span>NÃO → ${esc(meta.no || 'Registrar pendência')}</span></div></div>` : ''}
        ${executionImageGallery(process, step, run.currentIndex)}
        <label class="executionNote">Observação ou pendência desta etapa
          <textarea id="runStepNote" placeholder="Registre o que foi conferido, a pendência encontrada ou o motivo de não se aplicar.">${esc(stepState.note || '')}</textarea>
        </label>
        <div class="stepDecisionActions">
          <button type="button" class="primary" id="markRunDone">✓ Concluir etapa</button>
          <button type="button" class="secondary" id="markRunNA">— Não se aplica</button>
          <button type="button" class="secondary" id="markRunPending">↺ Deixar pendente</button>
        </div>
        <div class="executionNav">
          <button type="button" class="secondary" id="previousRunStep" ${run.currentIndex <= 0 ? 'disabled' : ''}>← Anterior</button>
          <button type="button" class="secondary" id="nextRunStep" ${run.currentIndex >= steps.length - 1 ? 'disabled' : ''}>Próxima →</button>
        </div>
      </div>
    </div>
    <label class="executionGeneralNote">Observação geral do processo
      <textarea id="runGeneralNote" placeholder="Pendências gerais, documentos relacionados e providências.">${esc(run.generalNote || '')}</textarea>
    </label>
    <div class="executionFinish">
      <span>${progress.completed} de ${progress.total} etapas tratadas</span>
      <button type="button" class="primary" id="finishRun">Finalizar processo</button>
    </div>`;
  $('#backToRuns').onclick = () => {
    activeRunId = null;
    workspace.hidden = true;
    renderRunningDashboard();
  };
  $('#runResponsible').onchange = (event) => saveRunField(run.id, 'responsible', event.target.value.trim());
  $('#runReference').onchange = (event) => saveRunField(run.id, 'reference', event.target.value.trim());
  $('#runStepNote').onchange = (event) => saveRunStepNote(run.id, step, event.target.value);
  $('#runGeneralNote').onchange = (event) => saveRunField(run.id, 'generalNote', event.target.value);
  $('#markRunDone').onclick = () => setRunStepStatus(run.id, step, 'done', true);
  $('#markRunNA').onclick = () => setRunStepStatus(run.id, step, 'na', true);
  $('#markRunPending').onclick = () => setRunStepStatus(run.id, step, '', false);
  $('#previousRunStep').onclick = () => moveRunStep(run.id, -1);
  $('#nextRunStep').onclick = () => moveRunStep(run.id, 1);
  $('#finishRun').onclick = () => finishRun(run.id);
  $$('[data-go-run-step]').forEach((button) => button.onclick = () => {
    run.currentIndex = Number(button.dataset.goRunStep);
    run.updatedAt = new Date().toISOString();
    dbSet('processRuns', processRuns);
    renderExecutionWorkspace();
  });
  bindStepImageTools(process, workspace);
  workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveRunField(runId, field, value) {
  const run = processRuns[runId];
  if (!run) return;
  run[field] = value;
  run.updatedAt = new Date().toISOString();
  await dbSet('processRuns', processRuns);
}

async function saveRunStepNote(runId, step, note) {
  const run = processRuns[runId];
  if (!run) return;
  run.steps[step] = run.steps[step] || {};
  run.steps[step].note = note.trim();
  run.updatedAt = new Date().toISOString();
  await dbSet('processRuns', processRuns);
}

async function setRunStepStatus(runId, step, status, advance) {
  const run = processRuns[runId];
  const process = findProcessById(run?.processId);
  if (!run || !process) return;
  run.steps[step] = run.steps[step] || {};
  run.steps[step].status = status;
  run.steps[step].completedAt = status ? new Date().toISOString() : null;
  run.updatedAt = new Date().toISOString();
  if (advance && run.currentIndex < process.steps.length - 1) run.currentIndex += 1;
  await dbSet('processRuns', processRuns);
  renderExecutionWorkspace();
}

function moveRunStep(runId, direction) {
  const run = processRuns[runId];
  const process = findProcessById(run?.processId);
  if (!run || !process) return;
  run.currentIndex = Math.max(0, Math.min((run.currentIndex || 0) + direction, process.steps.length - 1));
  run.updatedAt = new Date().toISOString();
  dbSet('processRuns', processRuns);
  renderExecutionWorkspace();
}

async function finishRun(runId) {
  const run = processRuns[runId];
  const process = findProcessById(run?.processId);
  if (!run || !process) return;
  const progress = runProgress(run, process);
  if (progress.completed < progress.total && !confirm(`Ainda existem ${progress.total - progress.completed} etapas pendentes. Finalizar mesmo assim?`)) return;
  run.status = 'completed';
  run.completedAt = new Date().toISOString();
  run.updatedAt = run.completedAt;
  await dbSet('processRuns', processRuns);
  activeRunId = null;
  $('#executionWorkspace').hidden = true;
  renderRunningDashboard();
  renderProcesses();
  toast('Processo finalizado e registrado no histórico.');
}

async function archiveRun(runId) {
  const run = processRuns[runId];
  if (!run || !confirm('Arquivar esta execução sem marcá-la como concluída?')) return;
  run.status = 'cancelled';
  run.updatedAt = new Date().toISOString();
  await dbSet('processRuns', processRuns);
  if (activeRunId === runId) activeRunId = null;
  renderRunningDashboard();
  renderProcesses();
}

function updateOrganizerControls() {
  const count = selectedProcessIds.size;
  $('#selectedCount').hidden = !organizeMode;
  $('#groupSelected').hidden = !organizeMode;
  $('#clearProcessSelection').hidden = !organizeMode;
  $('#selectedCount').textContent = `${count} selecionado${count === 1 ? '' : 's'}`;
  $('#groupSelected').disabled = count < 2;
  $('#groupSelected').textContent = count >= 2 ? `Criar bloco único (${count})` : 'Criar bloco único';
  $('#organizeToggle').textContent = organizeMode ? 'Concluir organização' : 'Organizar blocos';
  $('#organizeToggle').classList.toggle('primary', organizeMode);
  $('#organizeToggle').classList.toggle('secondary', !organizeMode);
}

function setOrganizeMode(enabled) {
  organizeMode = enabled;
  selectedProcessIds.clear();
  $('#searchInput').value = '';
  $('#categoryFilter').value = '';
  $('#processDetail').hidden = true;
  renderProcesses();
}

function toggleProcessSelection(id) {
  if (selectedProcessIds.has(id)) selectedProcessIds.delete(id);
  else selectedProcessIds.add(id);
  renderProcesses();
}

async function persistProcessLayout(message) {
  appState.updatedAt = new Date().toISOString();
  draftProcesses = clone(appState.processes);
  await persist();
  renderAll();
  toast(message);
}

async function reorderProcess(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const sourceIndex = appState.processes.findIndex((process) => process.id === sourceId);
  const targetIndex = appState.processes.findIndex((process) => process.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = appState.processes.splice(sourceIndex, 1);
  appState.processes.splice(targetIndex, 0, moved);
  await persistProcessLayout('Ordem dos blocos atualizada.');
}

async function moveProcess(id, direction) {
  const index = appState.processes.findIndex((process) => process.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= appState.processes.length) return;
  [appState.processes[index], appState.processes[target]] = [appState.processes[target], appState.processes[index]];
  await persistProcessLayout('Bloco reposicionado.');
}

async function saveOrganizationVersion(name, note) {
  const id = uid();
  versions.push({
    id,
    name,
    createdAt: new Date().toISOString(),
    note,
    processes: clone(appState.processes)
  });
  if (versions.length > 40) versions = versions.slice(-40);
  appState.activeVersionId = id;
  await persistProcessLayout(note);
}

async function groupSelectedProcesses() {
  const selected = appState.processes.filter((process) => selectedProcessIds.has(process.id));
  if (selected.length < 2) return;
  const title = prompt('Nome do novo bloco:', 'Novo grupo de processos')?.trim();
  if (!title) return;
  const firstIndex = Math.min(...selected.map((process) => appState.processes.indexOf(process)));
  const children = selected.flatMap((process) => process.isGroup && Array.isArray(process.children)
    ? process.children
    : [process]);
  appState.processes = appState.processes.filter((process) => !selectedProcessIds.has(process.id));
  appState.processes.splice(firstIndex, 0, {
    id: `grupo-${uid()}`,
    title,
    category: 'Grupo de processos',
    icon: '📁',
    goal: `${flattenProcesses(children).length} processos reunidos em um único bloco.`,
    warning: '',
    steps: [],
    details: [],
    paths: [],
    accounts: [],
    copy: '',
    origin: 'Agrupamento criado no app',
    reviewStatus: 'Grupo reversível',
    isGroup: true,
    children: clone(children)
  });
  selectedProcessIds.clear();
  await saveOrganizationVersion(`Grupo: ${title}`, `Processos agrupados no bloco "${title}".`);
}

async function ungroupProcesses(groupId) {
  const index = appState.processes.findIndex((process) => process.id === groupId && process.isGroup);
  if (index < 0) return;
  const group = appState.processes[index];
  if (!confirm(`Desagrupar "${group.title}" e restaurar os processos separados?`)) return;
  appState.processes.splice(index, 1, ...clone(group.children || []));
  await saveOrganizationVersion(`Desagrupado: ${group.title}`, `O bloco "${group.title}" foi desagrupado.`);
  $('#processDetail').hidden = true;
}

async function renameProcessGroup(groupId) {
  const group = appState.processes.find((process) => process.id === groupId && process.isGroup);
  if (!group) return;
  const title = prompt('Novo nome do bloco:', group.title)?.trim();
  if (!title || title === group.title) return;
  const oldTitle = group.title;
  group.title = title;
  await saveOrganizationVersion(`Grupo renomeado: ${title}`, `O bloco "${oldTitle}" foi renomeado para "${title}".`);
  openProcess(groupId);
}

function questionTokens(question) {
  const clean = normalize(question).replace(/[^a-z0-9\s>/+-]/g, ' ');
  const tokens = clean.split(/\s+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  const expanded = [...tokens];
  tokens.forEach((token) => {
    Object.entries(QUESTION_SYNONYMS).forEach(([key, values]) => {
      if (token === key || values.some((value) => normalize(value).includes(token))) expanded.push(key, ...values);
    });
  });
  return [...new Set(expanded.map(normalize))];
}

function scoreProcess(p, tokens, question) {
  const title = normalize(p.title);
  const category = normalize(p.category);
  const goal = normalize(p.goal);
  const operational = normalize([...(p.accounts || []), ...(p.paths || [])].join(' '));
  const full = normalize(JSON.stringify(p));
  let score = 0;
  tokens.forEach((token) => {
    if (title.includes(token)) score += 9;
    if (category.includes(token)) score += 5;
    if (operational.includes(token)) score += 6;
    if (goal.includes(token)) score += 3;
    if (full.includes(token)) score += 1;
  });
  if (title.includes(normalize(question))) score += 18;
  return score;
}

function bestMatchingStep(process, tokens) {
  let best = { index: 0, score: 0, step: process.steps?.[0] || '' };
  (process.steps || []).forEach((step, index) => {
    const text = normalize(step);
    const meta = normalize(JSON.stringify(process.stepMeta?.[step] || {}));
    let score = 0;
    tokens.forEach((token) => {
      if (text.includes(token)) score += 8;
      if (meta.includes(token)) score += 3;
    });
    if (score > best.score) best = { index, score, step };
  });
  return best;
}

function openLinkedProcess(id) {
  switchView('processos');
  $('#searchInput').value = '';
  $('#categoryFilter').value = '';
  renderProcesses();
  openProcess(id);
}

function renderAnswer(question) {
  const area = $('#answerArea');
  const tokens = questionTokens(question);
  if (!tokens.length) {
    area.innerHTML = '<article class="card emptyAnswer"><strong>Escreva uma dúvida mais específica.</strong><span>Inclua o documento, o sistema, a conta ou a etapa que você precisa executar.</span></article>';
    return;
  }
  const ranked = flattenProcesses()
    .map((process) => ({ process, score: scoreProcess(process, tokens, question) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!ranked.length) {
    area.innerHTML = '<article class="card emptyAnswer"><strong>Não encontrei uma resposta segura.</strong><span>Tente informar o nome do documento, a conta, a tela ou o comando usado no SISCOFIS/SIAFI.</span></article>';
    return;
  }
  const best = ranked[0].process;
  const matchedStep = bestMatchingStep(best, tokens);
  const matchedImages = processStepImages[best.id]?.[matchedStep.step] || [];
  const source = sourceInfo(best);
  area.innerHTML = `
    <article class="card answerPrimary">
      <div class="answerHeading">
        <div><span class="eyebrow">RESPOSTA MAIS PROVÁVEL</span><h2>${esc(best.icon || '📌')} ${esc(best.title)}</h2></div>
        <span class="sourceBadge ${source.className}">${source.label}</span>
      </div>
      <p class="answerGoal">${esc(best.goal || '')}</p>
      ${best.warning ? `<div class="warning"><strong>Atenção:</strong> ${esc(best.warning)}</div>` : ''}
      ${matchedStep.step ? `<div class="matchedStep">
        <span class="eyebrow">ETAPA MAIS RELACIONADA À DÚVIDA</span>
        <div class="step"><span class="stepNum">${matchedStep.index + 1}</span><strong>${esc(matchedStep.step)}</strong></div>
        ${matchedImages.length ? `<div class="matchedEvidence"><img src="${esc(matchedImages[0].dataUrl)}" alt="${esc(matchedImages[0].caption || 'Screenshot da etapa')}"><span>${matchedImages.length} screenshot${matchedImages.length === 1 ? '' : 's'} nesta etapa</span></div>` : ''}
      </div>` : ''}
      <h3>Contexto do passo a passo</h3>
      <div class="answerSteps">${(best.steps || []).slice(Math.max(0, matchedStep.index - 1), matchedStep.index + 3).map((step) => `<div class="step"><span class="stepNum">${(best.steps || []).indexOf(step) + 1}</span><span>${esc(step)}</span></div>`).join('')}</div>
      ${(best.paths || []).length ? `<div class="answerBox"><strong>Caminho no sistema</strong><span>${esc(best.paths[0])}</span></div>` : ''}
      ${(best.accounts || []).length ? `<div class="answerBox"><strong>Contas e referências</strong><span>${best.accounts.slice(0, 6).map(esc).join(' • ')}</span></div>` : ''}
      <div class="answerActions">
        <button class="primary runAnswerProcess" data-id="${esc(best.id)}" data-step="${matchedStep.index}">▶ Executar a partir desta etapa</button>
        <button class="secondary openAnswerProcess" data-id="${esc(best.id)}">Abrir processo completo</button>
      </div>
    </article>
    ${ranked.length > 1 ? `<div class="relatedAnswers"><h3>Também pode ajudar</h3>${ranked.slice(1).map(({process}) => `<button class="card relatedAnswer openAnswerProcess" data-id="${esc(process.id)}"><strong>${esc(process.icon || '📌')} ${esc(process.title)}</strong><span>${esc(process.goal || '')}</span></button>`).join('')}</div>` : ''}`;
  $$('.openAnswerProcess').forEach((button) => button.onclick = () => openLinkedProcess(button.dataset.id));
  $$('.runAnswerProcess').forEach((button) => button.onclick = () => startOrContinueRun(button.dataset.id, Number(button.dataset.step)));
}

function askQuestion(question) {
  const value = String(question || '').trim();
  if (!value) return;
  $('#questionInput').value = value;
  renderAnswer(value);
}

function stageProcesses(stage) {
  return stage.processIds.map((id) => findProcessById(id)).filter(Boolean);
}

function showMapStage(id) {
  const stage = FLOW_STAGES.find((item) => item.id === id);
  if (!stage) return;
  $$('.flowNode').forEach((button) => button.classList.toggle('selected', button.dataset.stage === id));
  const processes = stageProcesses(stage);
  $('#mapDetail').innerHTML = `
    <div class="mapDetailHeading"><span class="mapIcon">${stage.icon}</span><div><span class="eyebrow">ETAPA SELECIONADA</span><h2>${esc(stage.title)}</h2><p>${esc(stage.subtitle)}</p><div class="systemTags">${stage.systems.map((system) => `<span>${esc(system)}</span>`).join('')}</div></div></div>
    <div class="mapProcessList">${processes.map((process) => `<button class="mapProcess" data-id="${esc(process.id)}"><span>${esc(process.icon || '📌')}</span><strong>${esc(process.title)}</strong><small>${esc(sourceInfo(process).label)}</small></button>`).join('') || '<p>Nenhum processo relacionado foi encontrado.</p>'}</div>`;
  $$('.mapProcess').forEach((button) => button.onclick = () => openLinkedProcess(button.dataset.id));
}

function renderMindMap() {
  const map = $('#mindMap');
  if (!map) return;
  const node = (id, label) => {
    const stage = FLOW_STAGES.find((item) => item.id === id);
    return `<button class="flowNode" data-stage="${stage.id}"><span class="flowNodeIcon">${stage.icon}</span><span><strong>${esc(label || stage.title)}</strong><small>${esc(stage.subtitle)}</small><span class="systemTags">${stage.systems.map((system) => `<i>${esc(system)}</i>`).join('')}</span></span><b>${stageProcesses(stage).length}</b></button>`;
  };
  map.innerHTML = `
    <div class="flowchart" aria-label="Fluxograma da gestão patrimonial">
      <div class="terminator start">INÍCIO <small>Material ou documento chegou à seção</small></div>
      <div class="flowArrow">↓</div>
      ${node('receber')}
      <div class="flowArrow">↓</div>
      <div class="decisionWrap"><div class="decision"><span>Qual é a origem<br>da entrada?</span></div></div>
      <div class="branchLabels"><span>NOTA FISCAL</span><span>GUIA / TRANSFERÊNCIA</span></div>
      <div class="branchGrid">
        <div class="branchPath"><div class="branchArrow">↙</div>${node('liquidar')}<div class="flowArrow">↓</div><div class="miniCheck">NF liquidada e documento localizado?</div><div class="flowArrow">↓ SIM</div></div>
        <div class="branchPath"><div class="branchArrow">↘</div>${node('apropriar')}<div class="flowArrow">↓</div><div class="miniCheck">Há saldo em trânsito?</div><div class="flowArrow">↓ APROPRIAR</div></div>
      </div>
      <div class="merge"><span>ROTAS CONCLUÍDAS</span></div>
      <div class="flowArrow">↓</div>
      ${node('cadastrar')}
      <div class="flowArrow">↓</div>
      ${node('distribuir')}
      <div class="flowArrow">↓</div>
      ${node('controlar')}
      <div class="flowArrow">↓</div>
      <div class="decisionWrap"><div class="decision"><span>O bem continua<br>em uso?</span></div></div>
      <div class="usageBranches">
        <div><span class="answerLabel yes">SIM</span><div class="loopBox">Permanece em controle<br><small>Boletim, ficha e conferência semanal</small></div></div>
        <div><span class="answerLabel no">NÃO</span>${node('saida')}</div>
      </div>
      <div class="monthDivider"><span>AO FINAL DE CADA MÊS</span></div>
      ${node('bloquear')}
      <div class="flowArrow">↓</div>
      ${node('relatorios')}
      <div class="flowArrow">↓</div>
      <div class="decisionWrap"><div class="decision"><span>SIAFI =<br>SISCOFIS?</span></div></div>
      <div class="balanceBranches">
        <div><span class="answerLabel no">NÃO</span>${node('conciliar')}<div class="returnArrow">↺ Corrigir e conferir novamente</div></div>
        <div><span class="answerLabel yes">SIM</span>${node('arquivar')}</div>
      </div>
      <div class="flowArrow">↓</div>
      <div class="terminator end">FIM DO FECHAMENTO <small>Conformidade registrada e documentação arquivada</small></div>
    </div>`;
  $$('.flowNode').forEach((button) => button.onclick = () => showMapStage(button.dataset.stage));
  showMapStage('receber');
}

function renderEditorSelect() {
  const select = $('#editorSelect');
  const current = select.value;
  const editable = draftProcesses.filter((p) => !p.isGroup);
  select.innerHTML = editable.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
  if (editable.some((p) => p.id === current)) select.value = current;
  loadEditorForm();
}

function loadEditorForm() {
  const p = draftProcesses.find((x) => x.id === $('#editorSelect').value);
  if (!p) return;
  $('#edTitle').value = p.title || '';
  $('#edCategory').value = p.category || '';
  $('#edIcon').value = p.icon || '📌';
  $('#edStatus').value = p.reviewStatus || '';
  $('#edOrigin').value = p.origin || '';
  $('#edGoal').value = p.goal || '';
  $('#edWarning').value = p.warning || '';
  editorStepDraft = (p.steps || []).map((step) => ({
    text: step,
    type: p.stepMeta?.[step]?.type || 'action',
    yes: p.stepMeta?.[step]?.yes || '',
    no: p.stepMeta?.[step]?.no || ''
  }));
  syncEditorStepsToTextarea();
  renderVisualStepEditor();
  $('#edDetails').value = (p.details || []).join('\n');
  $('#edPaths').value = (p.paths || []).join('\n');
  $('#edAccounts').value = (p.accounts || []).join('\n');
  $('#edCopy').value = p.copy || '';
  $('#editorStatus').textContent = '';
}

function syncEditorStepsToTextarea() {
  $('#edSteps').value = editorStepDraft.map((step) => step.text.trim()).filter(Boolean).join('\n');
}

function renderVisualStepEditor() {
  const container = $('#visualStepEditor');
  if (!container) return;
  container.innerHTML = editorStepDraft.length ? editorStepDraft.map((step, index) => `
    <article class="visualStepRow ${step.type === 'decision' ? 'decisionStep' : ''}" data-visual-step="${index}">
      <div class="visualStepNumber">${index + 1}</div>
      <div class="visualStepFields">
        <input type="text" data-visual-step-text="${index}" value="${esc(step.text)}" placeholder="Descreva a etapa">
        <select data-visual-step-type="${index}" aria-label="Tipo da etapa">
          <option value="action" ${step.type !== 'decision' ? 'selected' : ''}>Ação</option>
          <option value="decision" ${step.type === 'decision' ? 'selected' : ''}>Decisão Sim/Não</option>
        </select>
        ${step.type === 'decision' ? `<div class="decisionFields">
          <input type="text" data-visual-step-yes="${index}" value="${esc(step.yes)}" placeholder="Se SIM, o que fazer?">
          <input type="text" data-visual-step-no="${index}" value="${esc(step.no)}" placeholder="Se NÃO, o que fazer?">
        </div>` : ''}
      </div>
      <div class="visualStepTools">
        <button type="button" draggable="true" class="visualDrag" data-visual-drag-handle="${index}" title="Arrastar etapa">⠿ Arrastar</button>
        <button type="button" data-visual-action="up" data-index="${index}" title="Mover para cima" ${index === 0 ? 'disabled' : ''}>↑ Subir</button>
        <button type="button" data-visual-action="down" data-index="${index}" title="Mover para baixo" ${index === editorStepDraft.length - 1 ? 'disabled' : ''}>↓ Descer</button>
        <button type="button" data-visual-action="duplicate" data-index="${index}" title="Duplicar">⧉ Duplicar</button>
        <button type="button" data-visual-action="split" data-index="${index}" title="Dividir">⑂ Dividir</button>
        <button type="button" data-visual-action="merge" data-index="${index}" title="Unir com a próxima" ${index === editorStepDraft.length - 1 ? 'disabled' : ''}>⊕ Unir abaixo</button>
        <button type="button" class="danger" data-visual-action="delete" data-index="${index}" title="Excluir">× Excluir</button>
      </div>
    </article>`).join('') : '<div class="emptyVisualSteps">Nenhuma etapa cadastrada. Toque em “Adicionar etapa”.</div>';
  $$('[data-visual-step-text]').forEach((input) => input.oninput = () => {
    editorStepDraft[Number(input.dataset.visualStepText)].text = input.value;
    syncEditorStepsToTextarea();
  });
  $$('[data-visual-step-type]').forEach((select) => select.onchange = () => {
    editorStepDraft[Number(select.dataset.visualStepType)].type = select.value;
    syncEditorStepsToTextarea();
    renderVisualStepEditor();
  });
  $$('[data-visual-step-yes]').forEach((input) => input.oninput = () => {
    editorStepDraft[Number(input.dataset.visualStepYes)].yes = input.value;
  });
  $$('[data-visual-step-no]').forEach((input) => input.oninput = () => {
    editorStepDraft[Number(input.dataset.visualStepNo)].no = input.value;
  });
  $$('[data-visual-action]').forEach((button) => button.onclick = () => handleVisualStepAction(button.dataset.visualAction, Number(button.dataset.index)));
  bindVisualStepDragging();
}

function handleVisualStepAction(action, index) {
  const step = editorStepDraft[index];
  if (!step) return;
  if (action === 'up' && index > 0) [editorStepDraft[index - 1], editorStepDraft[index]] = [editorStepDraft[index], editorStepDraft[index - 1]];
  if (action === 'down' && index < editorStepDraft.length - 1) [editorStepDraft[index + 1], editorStepDraft[index]] = [editorStepDraft[index], editorStepDraft[index + 1]];
  if (action === 'duplicate') editorStepDraft.splice(index + 1, 0, { ...clone(step), text: `${step.text} (cópia)` });
  if (action === 'delete' && confirm(`Excluir a etapa ${index + 1}?`)) editorStepDraft.splice(index, 1);
  if (action === 'split') {
    const second = prompt('Texto da segunda parte da etapa:', '')?.trim();
    if (second) {
      const first = prompt('Texto da primeira parte:', step.text)?.trim();
      if (first) {
        step.text = first;
        editorStepDraft.splice(index + 1, 0, { text: second, type: 'action', yes: '', no: '' });
      }
    }
  }
  if (action === 'merge' && index < editorStepDraft.length - 1) {
    step.text = `${step.text} ${editorStepDraft[index + 1].text}`.trim();
    editorStepDraft.splice(index + 1, 1);
  }
  syncEditorStepsToTextarea();
  renderVisualStepEditor();
}

function bindVisualStepDragging() {
  let sourceIndex = null;
  $$('[data-visual-step]').forEach((row) => {
    row.ondragover = (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (sourceIndex !== null && sourceIndex !== Number(row.dataset.visualStep)) row.classList.add('dragTarget');
    };
    row.ondragleave = () => row.classList.remove('dragTarget');
    row.ondrop = (event) => {
      event.preventDefault();
      const targetIndex = Number(row.dataset.visualStep);
      if (sourceIndex === null || sourceIndex === targetIndex) return;
      const [moved] = editorStepDraft.splice(sourceIndex, 1);
      editorStepDraft.splice(targetIndex, 0, moved);
      syncEditorStepsToTextarea();
      renderVisualStepEditor();
    };
  });
  $$('[data-visual-drag-handle]').forEach((handle) => {
    handle.ondragstart = (event) => {
      sourceIndex = Number(handle.dataset.visualDragHandle);
      handle.closest('[data-visual-step]')?.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(sourceIndex));
    };
    handle.ondragend = () => {
      sourceIndex = null;
      handle.closest('[data-visual-step]')?.classList.remove('dragging');
      $$('[data-visual-step]').forEach((item) => item.classList.remove('dragTarget'));
    };
  });
  if (!window.PointerEvent) return;
  $$('[data-visual-drag-handle]').forEach((handle) => {
    handle.onpointerdown = (event) => {
      if (event.pointerType === 'mouse') return;
      event.preventDefault();
      const from = Number(handle.dataset.visualDragHandle);
      const source = handle.closest('[data-visual-step]');
      source.classList.add('dragging');
      handle.setPointerCapture?.(event.pointerId);
      const clear = () => $$('[data-visual-step]').forEach((row) => row.classList.remove('dragTarget'));
      const move = (moveEvent) => {
        moveEvent.preventDefault();
        clear();
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('[data-visual-step]');
        if (target && Number(target.dataset.visualStep) !== from) target.classList.add('dragTarget');
      };
      const finish = (endEvent) => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', cancel);
        const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest('[data-visual-step]');
        source.classList.remove('dragging');
        clear();
        if (target && Number(target.dataset.visualStep) !== from) {
          const [moved] = editorStepDraft.splice(from, 1);
          editorStepDraft.splice(Number(target.dataset.visualStep), 0, moved);
          syncEditorStepsToTextarea();
          renderVisualStepEditor();
        }
      };
      const cancel = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', cancel);
        source.classList.remove('dragging');
        clear();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', cancel);
    };
  });
}

function migrateStepLinkedData(processId, oldSteps, newSteps) {
  if (JSON.stringify(oldSteps) === JSON.stringify(newSteps)) return;
  const oldImages = processStepImages[processId] || {};
  const oldChecklist = processChecklistData[processId] || {};
  const nextImages = {};
  const nextChecklist = {};
  newSteps.forEach((newStep, index) => {
    const oldStep = oldSteps[index];
    if (!oldStep) return;
    if (oldImages[oldStep]) nextImages[newStep] = oldImages[oldStep];
    if (oldChecklist[oldStep]) nextChecklist[newStep] = true;
  });
  processStepImages[processId] = nextImages;
  processChecklistData[processId] = nextChecklist;
  Object.values(processRuns).filter((run) => run.processId === processId).forEach((run) => {
    const oldRunSteps = run.steps || {};
    const nextRunSteps = {};
    newSteps.forEach((newStep, index) => {
      const oldStep = oldSteps[index];
      if (oldStep && oldRunSteps[oldStep]) nextRunSteps[newStep] = oldRunSteps[oldStep];
    });
    run.steps = nextRunSteps;
    run.currentIndex = Math.min(run.currentIndex || 0, Math.max(0, newSteps.length - 1));
    run.updatedAt = new Date().toISOString();
  });
}

function applyFormToDraft() {
  const p = draftProcesses.find((x) => x.id === $('#editorSelect').value);
  if (!p) throw new Error('Processo não encontrado.');
  const title = $('#edTitle').value.trim();
  if (!title) throw new Error('Informe o título do processo.');
  const oldSteps = [...(p.steps || [])];
  const steps = editorStepDraft.map((step) => step.text.trim()).filter(Boolean);
  const stepMeta = {};
  editorStepDraft.forEach((step) => {
    const text = step.text.trim();
    if (text && step.type === 'decision') stepMeta[text] = { type: 'decision', yes: step.yes.trim(), no: step.no.trim() };
  });
  Object.assign(p, {
    title,
    category: $('#edCategory').value.trim() || 'Sem categoria',
    icon: $('#edIcon').value.trim() || '📌',
    reviewStatus: $('#edStatus').value.trim(),
    origin: $('#edOrigin').value.trim(),
    goal: $('#edGoal').value.trim(),
    warning: $('#edWarning').value.trim(),
    steps,
    stepMeta,
    details: lines('#edDetails'),
    paths: lines('#edPaths'),
    accounts: lines('#edAccounts'),
    copy: $('#edCopy').value.trim()
  });
  migrateStepLinkedData(p.id, oldSteps, steps);
  return p;
}

function uniqueId(base) {
  const root = normalize(base).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'novo_processo';
  let id = root;
  let n = 2;
  while (flattenProcesses(draftProcesses).some((p) => p.id === id)) id = `${root}_${n++}`;
  return id;
}

async function saveNewVersion(event) {
  event.preventDefault();
  try {
    const edited = applyFormToDraft();
    const name = $('#versionName').value.trim() || `Edição de ${edited.title}`;
    const id = uid();
    const version = {
      id,
      name,
      createdAt: new Date().toISOString(),
      note: `Processo alterado: ${edited.title}`,
      processes: clone(draftProcesses)
    };
    versions.push(version);
    if (versions.length > 40) versions = versions.slice(-40);
    appState.processes = clone(draftProcesses);
    appState.activeVersionId = id;
    appState.updatedAt = new Date().toISOString();
    await persist();
    $('#versionName').value = '';
    $('#editorStatus').textContent = `Versão salva: ${name}`;
    renderAll();
    toast('Nova versão salva no PWA.');
  } catch (error) {
    $('#editorStatus').textContent = error.message;
  }
}

function newProcess() {
  const p = {
    id: uniqueId('novo_processo'), title: 'Novo processo', category: 'Em elaboração', icon: '📝',
    goal: '', warning: '', steps: [], details: [], paths: [], accounts: [], copy: '',
    origin: 'Criado no PWA V63', reviewStatus: 'Em elaboração'
  };
  draftProcesses.push(p);
  renderEditorSelect();
  $('#editorSelect').value = p.id;
  loadEditorForm();
  toast('Novo processo criado na edição atual.');
}

function duplicateProcess() {
  const source = draftProcesses.find((x) => x.id === $('#editorSelect').value);
  if (!source) return;
  const copyProcess = clone(source);
  copyProcess.id = uniqueId(`${source.id}_copia`);
  copyProcess.title = `${source.title} - cópia`;
  copyProcess.reviewStatus = 'Cópia em edição';
  draftProcesses.push(copyProcess);
  renderEditorSelect();
  $('#editorSelect').value = copyProcess.id;
  loadEditorForm();
}

function deleteProcess() {
  const id = $('#editorSelect').value;
  const p = draftProcesses.find((x) => x.id === id);
  if (!p || draftProcesses.length <= 1) return;
  if (!confirm(`Excluir "${p.title}" desta edição? As versões anteriores continuarão guardadas.`)) return;
  draftProcesses = draftProcesses.filter((x) => x.id !== id);
  renderEditorSelect();
}

function discardChanges() {
  if (!confirm('Descartar todas as alterações ainda não salvas?')) return;
  draftProcesses = clone(appState.processes);
  renderEditorSelect();
  toast('Alterações não salvas descartadas.');
}

function renderHistory() {
  const list = [...versions].reverse();
  $('#historyList').innerHTML = list.map((v) => `
    <article class="historyItem ${v.id === appState.activeVersionId ? 'active' : ''}">
      <div>
        <h3>${esc(v.name)} ${v.id === appState.activeVersionId ? '<span class="badge">ATIVA</span>' : ''}</h3>
        <p>${new Date(v.createdAt).toLocaleString('pt-BR')} · ${flattenProcesses(v.processes).length} processos${v.note ? ` · ${esc(v.note)}` : ''}</p>
      </div>
      <div class="actionRow">
        <button class="secondary restoreVersion" data-id="${esc(v.id)}">Restaurar</button>
        ${versions.length > 1 ? `<button class="danger deleteVersion" data-id="${esc(v.id)}">Apagar</button>` : ''}
      </div>
    </article>`).join('');
  $$('.restoreVersion').forEach((b) => b.onclick = () => restoreVersion(b.dataset.id));
  $$('.deleteVersion').forEach((b) => b.onclick = () => deleteVersion(b.dataset.id));
}

async function restoreVersion(id) {
  const v = versions.find((x) => x.id === id);
  if (!v) return;
  if (!confirm(`Restaurar a versão "${v.name}"? As outras versões permanecerão guardadas.`)) return;
  appState.processes = clone(v.processes);
  appState.activeVersionId = id;
  draftProcesses = clone(v.processes);
  await persist();
  renderAll();
  renderHistory();
  toast('Versão restaurada.');
}

async function deleteVersion(id) {
  const v = versions.find((x) => x.id === id);
  if (!v || versions.length <= 1) return;
  if (!confirm(`Apagar a versão "${v.name}" do histórico?`)) return;
  versions = versions.filter((x) => x.id !== id);
  if (appState.activeVersionId === id) {
    const latest = versions[versions.length - 1];
    appState.activeVersionId = latest.id;
    appState.processes = clone(latest.processes);
    draftProcesses = clone(latest.processes);
  }
  await persist();
  renderAll();
  renderHistory();
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function imageStorageBytes() {
  let total = 0;
  Object.values(processStepImages).forEach((steps) => {
    Object.values(steps || {}).forEach((images) => {
      (images || []).forEach((image) => {
        const value = image.dataUrl || '';
        const payload = value.includes(',') ? value.split(',')[1] : value;
        total += Math.ceil(payload.length * 0.75);
      });
    });
  });
  return total;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

async function renderStorageUsage() {
  const used = $('#storageUsed');
  const detail = $('#storageDetail');
  const bar = $('#storageBar');
  if (!used || !detail || !bar) return;
  const imageBytes = imageStorageBytes();
  try {
    const estimate = await navigator.storage?.estimate?.();
    const usage = estimate?.usage || imageBytes;
    const quota = estimate?.quota || 0;
    const percent = quota ? Math.min(100, Math.max(1, (usage / quota) * 100)) : 0;
    used.textContent = `${formatBytes(usage)} usados`;
    detail.textContent = `${formatBytes(imageBytes)} em screenshots${quota ? ` · limite estimado ${formatBytes(quota)}` : ''}`;
    bar.style.width = `${percent}%`;
  } catch {
    used.textContent = `${formatBytes(imageBytes)} em screenshots`;
    detail.textContent = 'O navegador não informou o limite disponível.';
    bar.style.width = '0%';
  }
}

function exportBackup() {
  downloadJson({ backupFormat: 3, exportedAt: new Date().toISOString(), appState, versions, processChecklistData, processStepImages, processRuns }, `material_permanente_backup_${new Date().toISOString().slice(0, 10)}.json`);
  $('#backupStatus').textContent = 'Backup completo exportado com processos, execuções, checklists e screenshots.';
}

async function importBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.appState?.processes || !Array.isArray(data.versions)) throw new Error('Arquivo de backup inválido.');
    if (!confirm(`Importar backup com ${data.versions.length} versões? O banco atual será substituído.`)) return;
    appState = data.appState;
    versions = data.versions;
    processChecklistData = data.processChecklistData && typeof data.processChecklistData === 'object' ? data.processChecklistData : {};
    processStepImages = data.processStepImages && typeof data.processStepImages === 'object' ? data.processStepImages : {};
    processRuns = data.processRuns && typeof data.processRuns === 'object' ? data.processRuns : {};
    activeRunId = null;
    const base = await loadBaseData();
    const added = syncNewBaseProcesses(appState, base);
    baseUpdatesAdded = added.length;
    if (added.length) {
      const versionId = uid();
      appState.activeVersionId = versionId;
      versions.push({
        id: versionId,
        name: `Backup atualizado para ${base.appVersion || 'a base atual'}`,
        createdAt: new Date().toISOString(),
        note: `${added.length} processo${added.length === 1 ? '' : 's'} novo${added.length === 1 ? '' : 's'} acrescentado${added.length === 1 ? '' : 's'} ao backup importado.`,
        processes: clone(appState.processes)
      });
    }
    draftProcesses = clone(appState.processes);
    await persist();
    renderAll();
    $('#backupStatus').textContent = added.length
      ? `Backup importado e atualizado com ${added.length} processos novos.`
      : 'Backup importado com sucesso.';
  } catch (error) {
    $('#backupStatus').textContent = error.message;
  } finally {
    event.target.value = '';
  }
}

async function resetBase() {
  if (!confirm('Restaurar a base original? Exporte um backup antes se quiser preservar suas versões atuais.')) return;
  const base = await loadBaseData();
  const id = uid();
  appState = { ...base, activeVersionId: id };
  versions = [{ id, name: 'Base original restaurada', createdAt: new Date().toISOString(), note: 'Reinicialização manual.', processes: clone(base.processes) }];
  draftProcesses = clone(base.processes);
  processChecklistData = {};
  processStepImages = {};
  processRuns = {};
  activeRunId = null;
  await persist();
  renderAll();
  $('#backupStatus').textContent = 'Base original restaurada.';
}

function renderAll() {
  if ($('#versionBadge')) $('#versionBadge').textContent = appState.appVersion || 'V63';
  renderStats();
  renderCategories();
  renderProcesses();
  renderEditorSelect();
  renderMindMap();
  renderRunningDashboard();
  renderHomeRunning();
  renderStorageUsage();
}

function bindEvents() {
  $$('.tab').forEach((b) => b.onclick = () => switchView(b.dataset.view));
  $$('[data-jump]').forEach((b) => b.onclick = () => switchView(b.dataset.jump));
  $('#searchInput').oninput = renderProcesses;
  $('#categoryFilter').onchange = renderProcesses;
  $('#organizeToggle').onclick = () => setOrganizeMode(!organizeMode);
  $('#groupSelected').onclick = groupSelectedProcesses;
  $('#clearProcessSelection').onclick = () => {
    selectedProcessIds.clear();
    renderProcesses();
  };
  $('#editorSelect').onchange = loadEditorForm;
  $('#addVisualStep').onclick = () => {
    editorStepDraft.push({ text: '', type: 'action', yes: '', no: '' });
    syncEditorStepsToTextarea();
    renderVisualStepEditor();
    setTimeout(() => $$('[data-visual-step-text]').at(-1)?.focus(), 0);
  };
  $('#edSteps').onchange = () => {
    editorStepDraft = lines('#edSteps').map((text, index) => ({
      text,
      type: editorStepDraft[index]?.type || 'action',
      yes: editorStepDraft[index]?.yes || '',
      no: editorStepDraft[index]?.no || ''
    }));
    renderVisualStepEditor();
  };
  $('#editorForm').onsubmit = saveNewVersion;
  $('#newProcess').onclick = newProcess;
  $('#duplicateProcess').onclick = duplicateProcess;
  $('#deleteProcess').onclick = deleteProcess;
  $('#discardChanges').onclick = discardChanges;
  $('#exportBackup').onclick = exportBackup;
  $('#importBackup').onchange = importBackup;
  $('#resetBase').onclick = resetBase;
  $('#refreshStorage').onclick = renderStorageUsage;
  $('#startRunFromDashboard').onclick = () => {
    switchView('processos');
    toast('Escolha um processo e toque em “Executar”.');
  };
  $('#questionForm').onsubmit = (event) => { event.preventDefault(); askQuestion($('#questionInput').value); };
  $$('.suggestion').forEach((button) => button.onclick = () => askQuestion(button.dataset.question));
}

function setupInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#installBtn').hidden = true;
  };
}

async function start() {
  bindEvents();
  setupInstall();
  try {
    await initializeData();
    renderAll();
    if (baseUpdatesAdded) {
      toast(`${baseUpdatesAdded} processos novos foram adicionados sem apagar suas alterações.`);
    }
  } catch (error) {
    document.querySelector('main').innerHTML = `<article class="card warning"><h2>Não foi possível iniciar</h2><p>${esc(error.message)}</p><p>Abra este pacote por um servidor local ou por hospedagem HTTPS.</p></article>`;
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        if (registration.waiting) toast('Nova versão disponível. Reabra o app para atualizar.');
        registration.addEventListener('updatefound', () => {
          registration.installing?.addEventListener('statechange', () => {
            if (registration.installing?.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Nova versão instalada. Reabra o app quando puder.');
            }
          });
        });
        return registration.update();
      })
      .catch(() => {});
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
