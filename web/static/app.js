/* ── PNCP Bot Web — App Logic ─────────────────────────────────────────── */

let allResults = [];
let currentFilter = "all";
let currentJobId = null;
let pollTimer = null;
let isSearchStopped = false; // Flag to stop client-side logic or server polling

// Feature 0: Date constraints
document.addEventListener("DOMContentLoaded", () => {
    const today = new Date();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(today.getFullYear() - 1);
    const formatDateItem = (d) => d.toISOString().split('T')[0];
    
    const fromInput = document.getElementById("date_from");
    const toInput = document.getElementById("date_to");
    if(fromInput) {
        fromInput.min = formatDateItem(oneYearAgo);
        fromInput.max = formatDateItem(today);
    }
    if(toInput) {
        toInput.min = formatDateItem(oneYearAgo);
        toInput.max = formatDateItem(today);
    }
});

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
    isSearchStopped = false;
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

    if (params.date_from) {
        const dFrom = new Date(params.date_from);
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        if (dFrom < oneYearAgo) {
            alert("A data de início não pode ser anterior a 1 ano atrás da data atual.");
            return;
        }
    }
    
    // Check for empty base keyword
    const testParsed = parseKeywords(params.keywords);
    if (!testParsed || testParsed.length === 0) {
        btnText.textContent = "⚠ Palavra Chave necessária";
        setTimeout(() => { btnText.textContent = "🔍 Buscar Itens"; }, 2000);
        return;
    }

    btn.disabled = true;
    btnText.textContent = "⏳ Buscando…";

    if (document.getElementById("local_processing").checked) {
        // Show skip button for local mode
        const skipBtn = document.getElementById("btn-skip-process");
        if (skipBtn) skipBtn.classList.remove("hidden");
        startLocalSearch(params);
        return;
    }
    // Hide skip button for server mode
    const skipBtn = document.getElementById("btn-skip-process");
    if (skipBtn) skipBtn.classList.add("hidden");

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

// ── Local Search Flow ───────────────────────────────────────────────────
async function startLocalSearch(params) {
    show("progress-section");
    hide("results-section");
    document.getElementById("log-panel").innerHTML = "";
    document.getElementById("progress-bar").style.width = "0%";
    document.getElementById("progress-label").textContent = "Iniciando Processamento Local…";
    
    // Feature 4: Build smart tags from keywords
    buildSmartTags(params.keywords);
    
    function logCB(msg) {
        const logPanel = document.getElementById("log-panel");
        let cls = "";
        if (msg.includes("✓")) cls = "log-success";
        else if (msg.includes("⚠") || msg.toLowerCase().includes("erro")) cls = "log-error";
        const div = document.createElement("div");
        div.className = cls;
        div.textContent = msg;
        logPanel.appendChild(div);
        logPanel.scrollTop = logPanel.scrollHeight;
    }
    
    function progCB(current, total, label) {
        const pct = Math.round((current / total) * 100);
        document.getElementById("progress-bar").style.width = pct + "%";
        document.getElementById("progress-label").textContent = `${label} (${current}/${total})`;
    }

    try {
        await runLocalExtraction(params, logCB, progCB);
        if (isSearchStopped) {
           finishSearchUI("⏹ Busca interrompida pelo usuário.", "error");
        } else {
           finishSearchUI(`✅ Concluído — ${allResults.length} itens encontrados.`, "done");
        }
    } catch (e) {
        console.error(e);
        logCB(`Erro fatal: ${e.message}`);
        finishSearchUI("⚠ Erro durante a extração local.", "error");
    }
}

function pollJob(jobId) {
    if (isSearchStopped) {
        clearInterval(pollTimer);
        pollTimer = null;
        finishSearchUI("⏹ Busca interrompida pelo usuário.", "error");
        return;
    }
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
                        "⚠ Erro durante a extração ou interrompido.";
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

function stopSearch() {
    isSearchStopped = true;
}

// ── Modal helpers ────────────────────────────────────────────────────────
function handleModalOverlayClick(event) {
    // Close only if click is directly on the overlay (not on modal-content child)
    if (event.target === event.currentTarget) {
        event.currentTarget.classList.add("hidden");
    }
}

function openHelpModal() {
    document.getElementById("help-modal").classList.remove("hidden");
}

function closeHelpModal() {
    document.getElementById("help-modal").classList.add("hidden");
}

function finishSearchUI(msg, status="done") {
    const btn = document.getElementById("btn-search");
    const btnText = document.getElementById("btn-search-text");
    btn.disabled = false;
    btnText.textContent = "🔍 Buscar Itens";
    document.getElementById("progress-bar").style.width = "100%";
    document.getElementById("progress-label").textContent = msg;
    if (allResults.length > 0) showResults();
}

// ── Results display ─────────────────────────────────────────────────────
function showResults() {
    show("results-section");
    updateStats();
    renderCards();
}

function updateStats() {
    const pending  = allResults.filter(r => r.status === "pending").length;
    const to_analyze = allResults.filter(r => r.status === "to_analyze").length;
    const approved = allResults.filter(r => r.status === "approved").length;
    const rejected = allResults.filter(r => r.status === "rejected").length;

    document.getElementById("results-stats").innerHTML = `
    <span><span class="dot dot-pending"></span> ${pending} pendentes</span>
    <span><span class="dot dot-to_analyze"></span> ${to_analyze} analisar</span>
    <span><span class="dot dot-approved"></span> ${approved} aprovados</span>
    <span><span class="dot dot-rejected"></span> ${rejected} rejeitados</span>
    <span>Total: ${allResults.length}</span>
  `;
}

function renderCards() {
    const grid = document.getElementById("items-grid");
    const search = (document.getElementById("filter-text").value || "").toLowerCase();

    const filtered = allResults.filter(item => {
        if (currentFilter !== "all" && item.status !== currentFilter) return false;
        if (search && !item.descricao.toLowerCase().includes(search)) return false;

        // Smart tag filter — item must contain ALL active tags (word-boundary)
        if (activeSmartTags.size > 0) {
            for (const tag of activeSmartTags) {
                if (!wordBoundaryMatch(tag, item.descricao)) return false;
            }
        }

        return true;
    });

    // Sort: "pending" items first (unreviewed), then treated items, rejected always last.
    filtered.sort((a, b) => {
        // Pending = not yet reviewed → top of queue
        const aPending = a.status === 'pending' ? 0 : 1;
        const bPending = b.status === 'pending' ? 0 : 1;
        if (aPending !== bPending) return aPending - bPending;

        // Among non-pending: rejected sink to bottom
        const aRejected = a.status === 'rejected' ? 1 : 0;
        const bRejected = b.status === 'rejected' ? 1 : 0;
        if (aRejected !== bRejected) return aRejected - bRejected;

        // Within same tier: exact matches first
        const qualityOrder = { exact: 0, compound: 1, partial: 2 };
        const qa = qualityOrder[a.match_quality] ?? 2;
        const qb = qualityOrder[b.match_quality] ?? 2;
        return qa - qb;
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
                : item.status === "to_analyze" ? "Analisar"
                : "Rejeitado";
        // Page number for navigation reference
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
          <span class="tag tag-keyword">🔑 ${escapeHtml(item.matched_keywords)}</span>
        </div>
        <p class="card-org">${escapeHtml(item.contratante)}</p>
        <div class="card-actions">
          <button class="card-btn card-btn-approve" onclick="setStatus(${idx},'approved')">✓ Aprovar</button>
          <button class="card-btn card-btn-analyze" onclick="setStatus(${idx},'to_analyze')">🔎 Analisar</button>
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
            
            // Auto-Rejeição: se não houver dados
            if (!data.has_data) {
                setStatus(idx, 'rejected');
                return;
            }
            
            renderCards();
        })
        .catch(() => {
            // On fetch error: log only, do NOT auto-reject
            const logPanel = document.getElementById('log-panel');
            if (logPanel) {
                const div = document.createElement('div');
                div.className = 'log-error';
                div.textContent = `Erro no processamento de ${item.process_id}`;
                logPanel.appendChild(div);
                logPanel.scrollTop = logPanel.scrollHeight;
            }
            checkCache[checkKey] = { status: 'empty' };
            renderCards();
        });
}

// Feature 4: Smart Tags — decompose new syntax into individual filter chips
function buildSmartTags(keywordsStr) {
    activeSmartTags.clear();
    const container = document.getElementById("smart-tags");
    container.innerHTML = "";

    // Extract all filter tokens from [...] blocks:
    // bare terms (AND) and {} alternatives (OR) are each separate chips
    const chips = [];
    const bracketRegex = /\[([^\]]+)\]/g;
    let m;
    while ((m = bracketRegex.exec(keywordsStr)) !== null) {
        const inner = m[1];
        // find {} groups and bare tokens, separated by |
        const innerRegex = /\{([^}]+)\}|([^|{}]+)/g;
        let im;
        while ((im = innerRegex.exec(inner)) !== null) {
            if (im[1]) {
                // OR group — each alternative becomes its own chip
                im[1].split('|').forEach(alt => {
                    const t = alt.trim();
                    if (t) chips.push(t);
                });
            } else if (im[2]) {
                // bare AND token
                const t = im[2].trim();
                if (t) chips.push(t);
            }
        }
    }

    if (chips.length === 0) return;

    chips.forEach(tag => {
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
    document.getElementById("search-form").reset(); // Libera filtros visuais
    document.getElementById("filter-text").value = ""; // Limpa searchbox do grid
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

// ── AI Prompt ───────────────────────────────────────────────────────────
function openAIPromptModal() {
    document.getElementById("ai-modal").classList.remove("hidden");
}

function closeAIPromptModal() {
    document.getElementById("ai-modal").classList.add("hidden");
}

function generateAIPrompt() {
    const mainDesc = document.getElementById("ai-main-desc").value.trim();
    if (!mainDesc) {
        alert("Por favor, insira a descrição principal.");
        return;
    }
    
    // Scope: only 'to_analyze' and 'approved' — pending and rejected excluded
    const validStatuses = ["to_analyze", "approved"];
    const itemsForAI = allResults
        .filter(r => validStatuses.includes(r.status))
        .map(r => ({
            id: r.item_id ? String(r.item_id) : r.process_id,
            descricao: r.descricao
        }));
        
    if (itemsForAI.length === 0) {
        // show inline feedback on the prompt button instead of alert
        const actionBtn = document.getElementById("btn-ai-prompt");
        if (actionBtn) {
            const orig = actionBtn.innerHTML;
            actionBtn.innerHTML = "⚠ Nenhum item em 'Analisar' ou 'Aprovado'";
            setTimeout(() => { actionBtn.innerHTML = orig; }, 2500);
        }
        return;
    }

    const payload = {
        pergunta: "Alguma das descrições abaixo atende aos critérios da Descrição Principal?",
        descricao_principal: mainDesc,
        itens_para_analise: itemsForAI,
        instrucao: "Responda indicando o ID do processo e o motivo da compatibilidade."
    };
    
    const jsonStr = JSON.stringify(payload, null, 2);
    
    
    const copyCallback = () => {
        // btn-ai-prompt is the action button *outside* the modal (in the results bar)
        // the modal's own button has no id, so we target both and use a toast fallback
        const actionBtn = document.getElementById("btn-ai-prompt");
        if (actionBtn) {
            const orig = actionBtn.innerHTML;
            actionBtn.innerHTML = "✓ Prompt Copiado!";
            actionBtn.style.backgroundColor = "var(--approved-color)";
            actionBtn.style.color = "#fff";
            setTimeout(() => {
                actionBtn.innerHTML = orig;
                actionBtn.style.backgroundColor = "";
                actionBtn.style.color = "";
            }, 2200);
        }
    };
    
    navigator.clipboard.writeText(jsonStr).then(() => {
        copyCallback();
        closeAIPromptModal();
    }).catch(err => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = jsonStr;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copyCallback();
        closeAIPromptModal();
    });
}
