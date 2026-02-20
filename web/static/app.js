/* ── PNCP Bot Web — App Logic ─────────────────────────────────────────── */

let allResults = [];
let currentFilter = "all";
let currentJobId = null;
let pollTimer = null;

// Feature 2: Track which items have been opened
const readItems = new Set();

// Feature 4: Active smart tag filters
const activeSmartTags = new Set();

// Feature 5: Cache for check-results per item
const checkCache = {}; // key: "cnpj/ano/seq/itemId" → { status, data }

// ── Feature 1: Pagination helper ────────────────────────────────────────
function getPageNumber(item) {
    const idx = parseInt(item.item_index, 10);
    if (isNaN(idx) || idx < 0) return 1;
    return Math.floor(idx / 50) + 1;
}

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

    // Feature 4: Build smart tags from keywords
    buildSmartTags(form.keywords.value);

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
    const compound = allResults.filter(r => r.match_quality === "compound").length;
    const partial = allResults.filter(r => r.match_quality === "partial").length;

    document.getElementById("results-stats").innerHTML = `
    <span><span class="dot dot-pending"></span> ${pending} pendentes</span>
    <span><span class="dot dot-approved"></span> ${approved} aprovados</span>
    <span><span class="dot dot-rejected"></span> ${rejected} rejeitados</span>
    <span><span class="dot dot-exact"></span> ${exact} exatos</span>
    <span><span class="dot dot-compound"></span> ${compound} compostos</span>
    <span><span class="dot dot-partial"></span> ${partial} parciais</span>
    <span>Total: ${allResults.length}</span>
  `;
}

function renderCards() {
    const grid = document.getElementById("items-grid");
    const search = (document.getElementById("filter-text").value || "").toLowerCase();

    const qualityFilters = ["exact", "compound", "partial"];

    const filtered = allResults.filter(item => {
        if (qualityFilters.includes(currentFilter) && item.match_quality !== currentFilter) return false;
        if (currentFilter !== "all" && !qualityFilters.includes(currentFilter) && item.status !== currentFilter) return false;
        if (search && !item.descricao.toLowerCase().includes(search)) return false;

        // Feature 4: Smart tag filter — item must contain ALL active tags (word-boundary)
        if (activeSmartTags.size > 0) {
            for (const tag of activeSmartTags) {
                if (!wordBoundaryMatch(tag, item.descricao)) return false;
            }
        }

        return true;
    });

    // Sort: exact first, then compound, then partial; within same quality sort by status
    filtered.sort((a, b) => {
        const qualityOrder = { exact: 0, compound: 1, partial: 2 };
        const qa = qualityOrder[a.match_quality] ?? 2;
        const qb = qualityOrder[b.match_quality] ?? 2;
        if (qa !== qb) return qa - qb;
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
            : item.match_quality === "compound"
                ? '<span class="tag tag-compound">◐ Match composto</span>'
                : '<span class="tag tag-partial">~ Match parcial</span>';

        // Feature 1: Page number
        const pageNum = getPageNumber(item);

        // Feature 2: Read badge
        const readBadge = readItems.has(idx)
            ? '<span class="badge badge-read">👁 Lido</span>'
            : '';

        // Feature 3: Copy ID & item identifier
        const itemLabel = `${escapeHtml(item.process_id)} / Item #${item.item_id}`;

        // Feature 5: Check results button state
        const checkKey = buildCheckKey(item);
        const checkState = checkCache[checkKey];
        let checkBtnClass = "card-btn card-btn-check";
        let checkBtnLabel = "🔍 Verificar";
        let checkTooltip = "";
        if (checkState) {
            if (checkState.status === "loading") {
                checkBtnClass += " check-loading";
                checkBtnLabel = "⏳ Verificando…";
            } else if (checkState.status === "ok") {
                checkBtnClass += " check-ok";
                checkBtnLabel = "✓ Dados disponíveis";
                checkTooltip = '<span class="check-tooltip">Dados adicionais disponíveis</span>';
            } else {
                checkBtnClass += " check-empty";
                checkBtnLabel = "— Sem resultados";
                checkTooltip = '<span class="check-tooltip">Sem dados adicionais</span>';
            }
        }

        return `
      <div class="card ${item.status}" data-idx="${idx}">
        <div class="card-top">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0">
            <span class="card-id">${itemLabel}</span>
            <span class="page-label">📄 Pág. ${pageNum}</span>
          </div>
          <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
            <span class="badge ${badgeClass}">${badgeText}</span>
            ${readBadge}
          </div>
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
          <button class="${checkBtnClass}" onclick="checkResults(${idx})" style="position:relative">${checkBtnLabel}${checkTooltip}</button>
          <button class="card-btn card-btn-copy" onclick="copyId(event, ${idx})">📋 Copiar ID</button>
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

// Feature 2 + Feature 3 (Deep Linking): open with text fragment and mark as read
function openProcess(idx) {
    readItems.add(idx);
    const item = allResults[idx];
    const deepUrl = item.source_url + `#:~:text=${encodeURIComponent(item.item_id)}`;
    window.open(deepUrl, "_blank");
    renderCards();
}

// ── Word-boundary matching helper ───────────────────────────────────────
function wordBoundaryMatch(term, text) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?<![a-zA-Z0-9])' + escaped + '(?![a-zA-Z0-9])', 'i');
    return re.test(text);
}

// Feature 3: Copy ID to clipboard (copies ONLY the item_id)
function copyId(event, idx) {
    event.stopPropagation();
    const item = allResults[idx];
    const text = `${item.item_id}`;

    const btn = event.currentTarget;
    const origText = btn.textContent;

    navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '✓ Copiado!';
        btn.classList.add('copy-success');
        setTimeout(() => {
            btn.textContent = origText;
            btn.classList.remove('copy-success');
        }, 1500);
    }).catch(() => {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = '✓ Copiado!';
        btn.classList.add('copy-success');
        setTimeout(() => {
            btn.textContent = origText;
            btn.classList.remove('copy-success');
        }, 1500);
    });
}

// Feature 5: Check additional results
function buildCheckKey(item) {
    // Extract cnpj/ano/seq from source_url: https://pncp.gov.br/app/editais/{cnpj}/{ano}/{seq}
    const parts = item.source_url.split("/");
    const seq = parts.pop();
    const ano = parts.pop();
    const cnpj = parts.pop();
    return `${cnpj}/${ano}/${seq}/${item.item_id}`;
}

function checkResults(idx) {
    const item = allResults[idx];
    const checkKey = buildCheckKey(item);

    // Don't re-fetch if already checked or loading
    if (checkCache[checkKey]) return;

    // Extract parts from source_url
    const parts = item.source_url.split("/");
    const seq = parts.pop();
    const ano = parts.pop();
    const cnpj = parts.pop();

    const apiUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens/${item.item_id}/resultados`;

    checkCache[checkKey] = { status: "loading" };
    renderCards();

    fetch(`/api/check-results?url=${encodeURIComponent(apiUrl)}`)
        .then(r => r.json())
        .then(data => {
            checkCache[checkKey] = {
                status: data.has_data ? "ok" : "empty",
                data: data.data || null,
            };
            renderCards();
        })
        .catch(() => {
            checkCache[checkKey] = { status: "empty" };
            renderCards();
        });
}

// Feature 4: Smart Tags
function buildSmartTags(keywordsStr) {
    activeSmartTags.clear();
    const container = document.getElementById("smart-tags");
    container.innerHTML = "";

    // Extract qualifiers from [...] and also individual words as potential tags
    const qualifiers = [];
    const regex = /\[([^\]]+)\]/g;
    let m;
    while ((m = regex.exec(keywordsStr)) !== null) {
        const inner = m[1];
        inner.split(",").forEach(q => {
            const trimmed = q.trim();
            if (trimmed) qualifiers.push(trimmed);
        });
    }

    if (qualifiers.length === 0) return;

    qualifiers.forEach(tag => {
        const btn = document.createElement("button");
        btn.className = "smart-tag";
        btn.textContent = tag;
        btn.addEventListener("click", () => {
            if (activeSmartTags.has(tag)) {
                activeSmartTags.delete(tag);
                btn.classList.remove("active");
            } else {
                activeSmartTags.add(tag);
                btn.classList.add("active");
            }
            renderCards();
        });
        container.appendChild(btn);
    });
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
    readItems.clear();
    activeSmartTags.clear();
    Object.keys(checkCache).forEach(k => delete checkCache[k]);
    hide("results-section");
    hide("progress-section");
    document.getElementById("smart-tags").innerHTML = "";
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
