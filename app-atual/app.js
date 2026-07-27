const STORAGE_KEY = "material-permanente-processos-backup";
const fileInput = document.querySelector("#fileInput");
const replaceBtn = document.querySelector("#replaceBtn");
const exportBtn = document.querySelector("#exportBtn");
const search = document.querySelector("#search");
let data = null;

const safeText = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[char]));

function findProcesses(value) {
  if (Array.isArray(value)) {
    const objects = value.filter((item) => item && typeof item === "object");
    if (objects.some((item) => item.title || item.titulo || item.steps || item.etapas)) return objects;
    for (const item of objects) {
      const found = findProcesses(item);
      if (found.length) return found;
    }
  }
  if (value && typeof value === "object") {
    for (const key of ["processes", "processos", "data", "items"]) {
      const found = findProcesses(value[key]);
      if (found.length) return found;
    }
  }
  return [];
}

function normalize(item, index) {
  const steps = item.steps || item.etapas || item.checklist || [];
  return {
    title: item.title || item.titulo || item.name || item.nome || `Processo ${index + 1}`,
    code: item.code || item.codigo || "",
    summary: item.summary || item.resumo || item.description || item.descricao || "",
    steps: Array.isArray(steps) ? steps.map((step) => typeof step === "string" ? step : step.title || step.text || step.descricao || JSON.stringify(step)) : [],
    raw: item,
  };
}

function render() {
  const empty = document.querySelector("#empty");
  const content = document.querySelector("#content");
  if (!data) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  const processes = findProcesses(data).map(normalize);
  const query = (search.value || "").toLocaleLowerCase("pt-BR");
  const filtered = processes.filter((item) => JSON.stringify(item).toLocaleLowerCase("pt-BR").includes(query));
  document.querySelector("#summary").textContent = processes.length
    ? `${filtered.length} de ${processes.length} processos exibidos`
    : "Backup carregado. O formato não possui uma lista reconhecível; o conteúdo bruto é mostrado abaixo.";
  document.querySelector("#processes").innerHTML = (filtered.length ? filtered : [{ title: "Conteúdo do backup", raw: data, steps: [] }]).map((item) => `
    <details class="process">
      <summary>${safeText(item.title)} ${item.code ? `— ${safeText(item.code)}` : ""}</summary>
      <div class="process-body">
        ${item.summary ? `<p>${safeText(item.summary)}</p>` : ""}
        ${item.steps?.length ? `<ol>${item.steps.map((step) => `<li>${safeText(step)}</li>`).join("")}</ol>` : `<pre class="raw">${safeText(JSON.stringify(item.raw, null, 2))}</pre>`}
      </div>
    </details>`).join("");
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      data = JSON.parse(reader.result);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      render();
    } catch {
      alert("Este arquivo não é um JSON válido.");
    }
  };
  reader.readAsText(file);
}

fileInput.addEventListener("change", (event) => event.target.files[0] && loadFile(event.target.files[0]));
replaceBtn.addEventListener("click", () => fileInput.click());
search.addEventListener("input", render);
exportBtn.addEventListener("click", () => {
  if (!data) return alert("Importe um backup primeiro.");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `material-permanente-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) data = JSON.parse(saved);
} catch {}
render();
