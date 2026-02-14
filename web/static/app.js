/* ── PNCP Bot Web — App Logic ─────────────────────────────────────────── */

let allResults = [];
let currentFilter = "all";
let currentJobId = null;
let pollTimer = null;

// ── Start search ────────────────────────────────────────────────────────
function startSearch(e) {
    e.preventDefault();
    const form = document.getElementById("search-form");
    const btn = document.getElementById("btn-search");
    const btnText = document.getElementById("btn-search-text");

    const params = {
        keywords: form.keywords.value,
        uf: form.uf.value,
        status: form.status.value,
        date_from: form.date_from.value,
        date_to: form.date_to.value,
        contratante: form.contratante.value,
        max_processes: parseInt(form.max_processes.value) || 30,
        fuzzy_threshold: parseInt(form.fuzzy_threshold.value) || 80,
        rate_limit: 1.0,
    };

    btn.disabled = true;
    btnText.textContent = "⏳ Buscando…";

    // show progress, hide results
    show("progress-section");
    hide("results-section");
    document.getElementById("log-panel").innerHTML = "";
    document.getElementById("progress-bar").style.width = "0%";
    document.getElementById("progress-label").textContent = "Iniciando…";

    fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
    })
        .then(r => r.json())
        .then(data => {
            currentJobId = data.job_id;
            pollTimer = setInterval(() => pollJob(currentJobId), 1500);
        })
        .catch(err => {
            alert("Erro ao iniciar busca: " + err);
            btn.disabled = false;
            btnText.textContent = "🔍 Buscar Itens";
        });
}

// ── Poll job status ─────────────────────────────────────────────────────
function pollJob(jobId) {
    fetch(`/api/job/${jobId}`)
        .then(r => r.json())
        .then(job => {
            // progress bar
            if (job.progress) {
                const pct = Math.round((job.progress.current / job.progress.total) * 100);
                document.getElementById("progress-bar").style.width = pct + "%";
                document.getElementById("progress-label").textContent =
                    `${job.progress.label} (${job.progress.current}/${job.progress.total})`;
            }

            // logs
            const logPanel = document.getElementById("log-panel");
            logPanel.innerHTML = job.logs.map(l => {
                let cls = "";
                if (l.includes("✓")) cls = "log-success";
                else if (l.includes("⚠")) cls = "log-warn";
                else if (l.includes("Erro")) cls = "log-error";
                return `<div class="${cls}">${escapeHtml(l)}</div>`;
            }).join("");
            logPanel.scrollTop = logPanel.scrollHeight;

            // done?
            if (job.status === "done" || job.status === "error" || job.status === "captcha") {
                clearInterval(pollTimer);
                pollTimer = null;

                const btn = document.getElementById("btn-search");
                const btnText = document.getElementById("btn-search-text");
                btn.disabled = false;
                btnText.textContent = "🔍 Buscar Itens";

                document.getElementById("progress-bar").style.width = "100%";

                if (job.status === "captcha") {
                    document.getElementById("progress-label").textContent =
                        "⚠ CAPTCHA detectado — resolva manualmente e tente novamente.";
                } else if (job.status === "error") {
                    document.getElementById("progress-label").textContent =
                        "⚠ Erro durante a extração.";
                } else {
                    document.getElementById("progress-label").textContent =
                        `✅ Concluído — ${job.total_results} itens encontrados.`;
                }

                if (job.results && job.results.length > 0) {
                    allResults = job.results;
                    showResults();
                }
            }
        })
        .catch(err => {
            console.error("Poll error:", err);
        });
}

// ── Results display ─────────────────────────────────────────────────────
function showResults() {
    show("results-section");
    updateStats();
    renderCards();
}

function updateStats() {
    const pending = allResults.filter(r => r.status === "pending").length;
    const approved = allResults.filter(r => r.status === "approved").length;
    const rejected = allResults.filter(r => r.status === "rejected").length;
    const exact = allResults.filter(r => r.match_quality === "exact").length;
    const partial = allResults.filter(r => r.match_quality === "partial").length;

    document.getElementById("results-stats").innerHTML = `
    <span><span class="dot dot-pending"></span> ${pending} pendentes</span>
    <span><span class="dot dot-approved"></span> ${approved} aprovados</span>
    <span><span class="dot dot-rejected"></span> ${rejected} rejeitados</span>
    <span><span class="dot dot-exact"></span> ${exact} exatos</span>
    <span><span class="dot dot-partial"></span> ${partial} parciais</span>
    <span>Total: ${allResults.length}</span>
  `;
}

function renderCards() {
    const grid = document.getElementById("items-grid");
    const search = (document.getElementById("filter-text").value || "").toLowerCase();

    const filtered = allResults.filter(item => {
        if (currentFilter === "exact" && item.match_quality !== "exact") return false;
        if (currentFilter !== "all" && currentFilter !== "exact" && item.status !== currentFilter) return false;
        if (search && !item.descricao.toLowerCase().includes(search)) return false;
        return true;
    });

    // Sort: exact matches first, then by status (pending first)
    filtered.sort((a, b) => {
        if (a.match_quality !== b.match_quality) {
            return a.match_quality === "exact" ? -1 : 1;
        }
        const statusOrder = { pending: 0, approved: 1, rejected: 2 };
        return (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
    });

    if (filtered.length === 0) {
        grid.innerHTML = '<p style="text-align:center;color:var(--text-dim);padding:40px">Nenhum item encontrado com esses filtros.</p>';
        return;
    }

    grid.innerHTML = filtered.map(item => {
        const idx = allResults.indexOf(item);
        const badgeClass = `badge-${item.status}`;
        const badgeText = item.status === "pending" ? "Pendente"
            : item.status === "approved" ? "Aprovado"
                : "Rejeitado";
        const qualityTag = item.match_quality === "exact"
            ? '<span class="tag tag-exact">✓ Match exato</span>'
            : '<span class="tag tag-partial">~ Match parcial</span>';

        return `
      <div class="card ${item.status}" data-idx="${idx}">
        <div class="card-top">
          <span class="card-id">${escapeHtml(item.process_id)} / Item #${item.item_id}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <p class="card-desc" title="${escapeHtml(item.descricao)}">${escapeHtml(item.descricao)}</p>
        <div class="card-meta">
          <span>Qtd: <strong>${item.quantidade} ${escapeHtml(item.unidade || '')}</strong></span>
          <span>Unit: <strong>${formatCurrency(item.valor_unitario)}</strong></span>
          <span>Total: <strong>${formatCurrency(item.valor_total)}</strong></span>
          <span>📅 ${formatDate(item.data_publicacao)}</span>
        </div>
        <div class="card-tags">
          ${qualityTag}
          <span class="tag tag-keyword">🔑 ${escapeHtml(item.matched_keywords)}</span>
        </div>
        <p class="card-org">${escapeHtml(item.contratante)}</p>
        <div class="card-actions">
          <button class="card-btn card-btn-approve" onclick="setStatus(${idx},'approved')">✓ Aprovar</button>
          <button class="card-btn card-btn-reject"  onclick="setStatus(${idx},'rejected')">✗ Rejeitar</button>
          <button class="card-btn card-btn-open"     onclick="openProcess(${idx})">↗ Abrir</button>
        </div>
      </div>
    `;
    }).join("");
}

// ── Actions ─────────────────────────────────────────────────────────────
function setStatus(idx, status) {
    allResults[idx].status = status;
    updateStats();
    renderCards();
}

function openProcess(idx) {
    window.open(allResults[idx].source_url, "_blank");
}

function exportApproved() {
    const approved = allResults.filter(r => r.status === "approved");
    if (!approved.length) {
        alert("Nenhum item aprovado. Aprove itens antes de exportar.");
        return;
    }

    fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: approved }),
    })
        .then(r => r.json())
        .then(data => {
            // also download as JSON
            const blob = new Blob([JSON.stringify(approved, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "approved_items.json";
            a.click();
            URL.revokeObjectURL(url);
            alert(`${data.count} itens exportados!\nJSON: ${data.json_path}\nCSV: ${data.csv_path}`);
        })
        .catch(err => alert("Erro ao exportar: " + err));
}

function newSearch() {
    allResults = [];
    hide("results-section");
    hide("progress-section");
    document.getElementById("search-form").reset();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Helpers ─────────────────────────────────────────────────────────────
function formatCurrency(val) {
    if (val == null) return "—";
    return "R$ " + Number(val).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function formatDate(iso) {
    if (!iso) return "—";
    return iso.substring(0, 10).split("-").reverse().join("/");
}

function escapeHtml(text) {
    if (!text) return "";
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
}

function show(id) { document.getElementById(id).classList.remove("hidden"); }
function hide(id) { document.getElementById(id).classList.add("hidden"); }

// ── Filter pills ────────────────────────────────────────────────────────
document.querySelectorAll(".pill[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".pill[data-filter]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentFilter = btn.dataset.filter;
        renderCards();
    });
});

document.getElementById("filter-text").addEventListener("input", () => renderCards());
