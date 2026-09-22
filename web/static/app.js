let allResults = [];
let currentFilter = "all";
let currentResultFilter = "all"; // 'all' | 'with_result' | 'without_result'
let currentJobId = null;
let pollTimer = null;
let isSearchStopped = false;

// ── Search History in Memory ──────────────────────────────────────────
const MAX_SEARCH_HISTORY = 15;
let searchHistory = [];
let activeSearchId = null;

// ── Toast System ─────────────────────────────────────────────────────────────
/**
 * showToast(message, type, duration)
 * type: 'success' | 'warn' | 'error' | 'info'
 */
function showToast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    const timeout = setTimeout(() => _removeToast(toast), duration);
    toast.addEventListener('click', () => { clearTimeout(timeout); _removeToast(toast); });
}

function _removeToast(toast) {
    toast.classList.remove('toast-visible');
    toast.classList.add('toast-hiding');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
}

// ── Web Notifications + document.title flip ───────────────────────────────────
const _ORIGINAL_TITLE = document.title;
let _titleFlipInterval = null;
let _activeNotification = null;

/**
 * Guard flag: while a search/extraction is running, notifications are
 * suppressed. Set to true at search start and false immediately before
 * calling notifyCompletion, so the notification only fires after the
 * full processing cycle — never mid-sweep.
 */
let _searchInProgress = false;

function _requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function _onVisibilityChange() {
    if (!document.hidden) {
        _stopTitleFlip();
    }
}

function _stopTitleFlip() {
    if (_titleFlipInterval) {
        clearInterval(_titleFlipInterval);
        _titleFlipInterval = null;
    }
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    document.title = _ORIGINAL_TITLE;
}

function notifyCompletion(itemCount) {
    // Unlock processing guard flag
    _searchInProgress = false;

    const countText = `${itemCount} ${itemCount === 1 ? 'item encontrado' : 'itens encontrados'}`;

    // 1. Toast Notification no app (sempre exibida na interface em qualquer pesquisa)
    showToast(`✅ Processamento concluído: ${countText}.`, 'success', 5000);

    // 2. Web Notification do Navegador (Desktop / Central de Ações do Windows)
    if ('Notification' in window) {
        const fireWebNotification = () => {
            try {
                // Fecha notificação anterior se ainda estiver aberta no sistema
                if (_activeNotification) {
                    try { _activeNotification.close(); } catch (_) {}
                    _activeNotification = null;
                }

                // Tag única por timestamp + renotify: true garante que o Windows / Chromium
                // dispare o banner e o alerta sonoro em TODAS as pesquisas subsequentes,
                // sem suprimir silenciosamente como acontecia com tag fixa e renotify: false.
                const notif = new Notification('PNCP Bot ✅', {
                    body: `${countText}. Processamento concluído.`,
                    tag: `pncp-done-${Date.now()}`,
                    renotify: true,
                });

                notif.onclick = () => {
                    window.focus();
                    try { notif.close(); } catch (_) {}
                };

                _activeNotification = notif;
            } catch (_) { /* alguns navegadores bloqueiam em contextos não-seguros */ }
        };

        if (Notification.permission === 'granted') {
            fireWebNotification();
        } else if (Notification.permission === 'default') {
            Notification.requestPermission().then(perm => {
                if (perm === 'granted') fireWebNotification();
            }).catch(() => {});
        }
    }

    // 3. document.title flip (visível quando a aba estiver em segundo plano)
    _stopTitleFlip();
    let flipping = true;
    _titleFlipInterval = setInterval(() => {
        document.title = flipping ? `✅ Processo Finalizado — PNCP Bot` : _ORIGINAL_TITLE;
        flipping = !flipping;
    }, 1500);

    document.addEventListener('visibilitychange', _onVisibilityChange);

    // Se o usuário clicar na página ou a janela ganhar foco, cancela o flip do título
    const stopOnUserAction = () => {
        _stopTitleFlip();
        window.removeEventListener('focus', stopOnUserAction);
        document.removeEventListener('click', stopOnUserAction);
    };
    window.addEventListener('focus', stopOnUserAction, { once: true });
    document.addEventListener('click', stopOnUserAction, { once: true });

    // Limite de segurança de 30 segundos
    setTimeout(_stopTitleFlip, 30_000);
}

// ── Unified log line colorizer ────────────────────────────────────────────────
function colorizeLog(msg) {
    if (msg.includes('✓')) return 'log-success';
    if (msg.includes('⚠') || msg.toLowerCase().includes('erro') || msg.toLowerCase().includes('timeout')) return 'log-error';
    if (msg.includes('CAPTCHA')) return 'log-warn';
    return '';
}

// ── Timer / Counter state ────────────────────────────────────────────────
let _timerInterval = null;
let _timerStart = null;
let _itemsVerified = 0;

function _startTimer() {
    _timerStart = Date.now();
    _itemsVerified = 0;
    _updateStatusPanel();
    _timerInterval = setInterval(_updateStatusPanel, 1000);
}

function _stopTimer() {
    if (_timerInterval) {
        clearInterval(_timerInterval);
        _timerInterval = null;
    }
}

function _elapsedStr() {
    if (!_timerStart) return "00:00";
    const secs = Math.floor((Date.now() - _timerStart) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    return `${mm}:${ss}`;
}

function _updateStatusPanel() {
    const el = document.getElementById("status-indicators");
    if (el) {
        el.innerHTML = `
          <span class="status-indicator">📦 Itens verificados: <strong>${_itemsVerified}</strong></span>
          <span class="status-indicator">⏱ Tempo decorrido: <strong>${_elapsedStr()}</strong></span>
        `;
    }
}

// Feature 0: Date constraints
document.addEventListener("DOMContentLoaded", () => {
    const today = new Date();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(today.getFullYear() - 1);
    const formatDateItem = (d) => d.toISOString().split('T')[0];

    const fromInput = document.getElementById("date_from");
    const toInput = document.getElementById("date_to");
    if (fromInput) {
        fromInput.min = formatDateItem(oneYearAgo);
        fromInput.max = formatDateItem(today);
    }
    if (toInput) {
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
    _searchInProgress = true;   // suppress notifications until processing is done

    // ── Hard reset: flush all state/cache from any previous run ──────────
    allResults = [];
    readItems.clear();
    activeSmartTags.clear();
    Object.keys(checkCache).forEach(k => delete checkCache[k]);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    currentJobId = null;
    _stopTitleFlip();
    if (_activeNotification) {
        try { _activeNotification.close(); } catch (_) {}
        _activeNotification = null;
    }
    // UI cleanup
    hide("results-section");
    document.getElementById("smart-tags").innerHTML = "";
    document.getElementById("filter-text").value = "";
    // Prompt Engine: clear AI main description
    const aiDescEl = document.getElementById("ai-main-desc");
    if (aiDescEl) aiDescEl.value = "";
    // Filter pills: reset to "Todos"
    currentFilter = "all";
    document.querySelectorAll(".pill[data-filter]").forEach(b => {
        b.classList.toggle("active", b.dataset.filter === "all");
    });
    currentResultFilter = "all";
    document.querySelectorAll(".pill[data-result-filter]").forEach(b => {
        b.classList.toggle("active", b.dataset.resultFilter === "all");
    });
    // ─────────────────────────────────────────────────────────────────────

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

    // Registra a nova pesquisa no histórico em memória
    registerNewSearch(params);

    btn.disabled = true;
    btnText.textContent = "⏳ Buscando…";

    // Request notification permission early (requires user gesture context)
    _requestNotificationPermission();

    if (document.getElementById("local_processing").checked) {
        const skipBtn = document.getElementById("btn-skip-process");
        if (skipBtn) skipBtn.classList.remove("hidden");
        startLocalSearch(params);
        return;
    }
    const skipBtn = document.getElementById("btn-skip-process");
    if (skipBtn) skipBtn.classList.add("hidden");

    // show progress, hide results
    show("progress-section");
    hide("results-section");
    document.getElementById("log-panel").innerHTML = "";
    document.getElementById("progress-bar").style.width = "0%";
    document.getElementById("progress-label").textContent = "Iniciando…";

    // start timer
    _startTimer();

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
            _stopTimer();
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

    // start timer / counter
    _startTimer();

    function logCB(msg) {
        const logPanel = document.getElementById("log-panel");
        const cls = colorizeLog(msg);
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
        _stopTimer();
        const elapsed = _elapsedStr();
        if (isSearchStopped) {
            _searchInProgress = false;
            const count = allResults.length;
            const msg = count > 0
                ? `⏹ Busca interrompida — ${count} ${count === 1 ? 'item retido' : 'itens retidos'}.`
                : "⏹ Busca interrompida pelo usuário.";
            finishSearchUI(msg, "cancelled");
        } else {
            finishSearchUI(`✅ Concluído — ${allResults.length} itens encontrados.`, "done");
            showCompletionLog(_itemsVerified, elapsed);
            _searchInProgress = false;  // unlock before firing notification
            notifyCompletion(allResults.length);
        }
    } catch (e) {
        _stopTimer();
        _searchInProgress = false;
        if (isSearchStopped) {
            const count = allResults.length;
            const msg = count > 0
                ? `⏹ Busca interrompida — ${count} ${count === 1 ? 'item retido' : 'itens retidos'}.`
                : "⏹ Busca interrompida pelo usuário.";
            finishSearchUI(msg, "cancelled");
        } else {
            console.error(e);
            logCB(`Erro fatal: ${e.message}`);
            finishSearchUI("⚠ Erro durante a extração local.", "error");
        }
    }
}

function pollJob(jobId) {
    if (isSearchStopped) {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        return;
    }
    fetch(`/api/job/${jobId}`)
        .then(r => r.json())
        .then(job => {
            if (isSearchStopped) return;

            // progress bar
            if (job.progress) {
                const pct = Math.round((job.progress.current / job.progress.total) * 100);
                document.getElementById("progress-bar").style.width = pct + "%";
                document.getElementById("progress-label").textContent =
                    `${job.progress.label} (${job.progress.current}/${job.progress.total})`;
            }

            // logs — usando colorizeLog unificado
            const logPanel = document.getElementById("log-panel");
            if (logPanel && job.logs) {
                logPanel.innerHTML = job.logs.map(l => {
                    const cls = colorizeLog(l);
                    return `<div class="${cls}">${escapeHtml(l)}</div>`;
                }).join("");
                logPanel.scrollTop = logPanel.scrollHeight;
            }

            // items_verified via campo dedicado (sem regex)
            if (job.items_verified > 0) {
                _itemsVerified = job.items_verified;
                _updateStatusPanel();
            }

            // Live streaming of matched results
            if (job.results && Array.isArray(job.results) && job.results.length > 0) {
                allResults = job.results;
                updateStats();
            }

            // Terminal status check:
            if (job.status === "done" || job.status === "error" || job.status === "captcha" || job.status === "cancelled") {
                clearInterval(pollTimer);
                pollTimer = null;
                _stopTimer();
                const elapsed = _elapsedStr();

                const btn = document.getElementById("btn-search");
                const btnText = document.getElementById("btn-search-text");
                btn.disabled = false;
                btnText.textContent = "🔍 Buscar Itens";

                document.getElementById("progress-bar").style.width = "100%";

                if (job.status === "captcha") {
                    document.getElementById("progress-label").textContent =
                        "⚠ CAPTCHA detectado — resolva manualmente e tente novamente.";
                    showToast("⚠ CAPTCHA detectado — resolva manualmente.", "warn");
                } else if (job.status === "error") {
                    document.getElementById("progress-label").textContent =
                        "⚠ Erro durante a extração ou interrompido.";
                    showToast("⚠ Erro durante a extração ou busca interrompida.", "error");
                } else if (job.status === "cancelled") {
                    const count = allResults.length;
                    const cMsg = count > 0
                        ? `⏹ Busca interrompida — ${count} ${count === 1 ? 'item retido' : 'itens retidos'}.`
                        : "⏹ Busca interrompida pelo usuário.";
                    document.getElementById("progress-label").textContent = cMsg;
                    showToast(cMsg, count > 0 ? "info" : "warn");
                } else {
                    document.getElementById("progress-label").textContent =
                        `✅ Concluído — ${job.total_results} itens encontrados.`;
                    showCompletionLog(_itemsVerified, elapsed);
                }

                if (job.results && job.results.length > 0) {
                    allResults = job.results;
                    if (job.status === "done") {
                        setFilter("to_analyze");
                    }
                    saveCurrentSearchState();
                    updateHistoryUI();
                    showResults();
                }

                if (job.status === "done") {
                    _searchInProgress = false;  // unlock before firing notification
                    notifyCompletion(job.total_results);
                } else {
                    _searchInProgress = false;
                }
            }
        })
        .catch(err => {
            console.error("Poll error:", err);
        });
}

async function stopSearch() {
    if (isSearchStopped) return;
    isSearchStopped = true;
    _searchInProgress = false;

    // 1. Abort local fetch if active
    if (window.currentFetchController) {
        try {
            window.currentFetchController.abort();
        } catch (_) {}
        window.currentFetchController = null;
    }

    // 2. Stop timer
    _stopTimer();

    // 3. Clear poll timer
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    // 4. If running server search and we have a currentJobId, cancel backend thread immediately
    if (currentJobId) {
        const jobIdToCancel = currentJobId;
        try {
            const resp = await fetch(`/api/job/${jobIdToCancel}/cancel`, {
                method: "POST",
                headers: { "Content-Type": "application/json" }
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.results && Array.isArray(data.results)) {
                    allResults = data.results;
                }
                if (data.logs && Array.isArray(data.logs)) {
                    const logPanel = document.getElementById("log-panel");
                    if (logPanel) {
                        logPanel.innerHTML = data.logs.map(l => `<div class="${colorizeLog(l)}">${escapeHtml(l)}</div>`).join("");
                        logPanel.scrollTop = logPanel.scrollHeight;
                    }
                }
                if (data.items_verified) {
                    _itemsVerified = data.items_verified;
                    _updateStatusPanel();
                }
            }
        } catch (err) {
            console.warn("Erro ao notificar cancelamento do job:", err);
        }
    }

    // 5. Update UI & memory history
    const count = allResults.length;
    const msg = count > 0
        ? `⏹ Busca interrompida — ${count} ${count === 1 ? 'item retido' : 'itens retidos'}.`
        : "⏹ Busca interrompida pelo usuário. Nenhum item encontrado até o momento.";

    finishSearchUI(msg, "cancelled");
    showToast(msg, count > 0 ? "info" : "warn");
}

// ── Completion Log (inline no painel) ───────────────────────────────────
function showCompletionLog(items, elapsed) {
    const logPanel = document.getElementById("log-panel");
    if (!logPanel) return;
    const div = document.createElement("div");
    div.className = "log-completion";
    div.textContent = `✅ Processamento finalizado: ${items} itens verificados em ${elapsed}.`;
    logPanel.appendChild(div);
    logPanel.scrollTop = logPanel.scrollHeight;
}

// ── Modal helpers ────────────────────────────────────────────────────────
function handleModalOverlayClick(event) {
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

function openAutoModal() {
    document.getElementById("auto-modal").classList.remove("hidden");
}

function closeAutoModal() {
    document.getElementById("auto-modal").classList.add("hidden");
}

function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll(".pill[data-filter]").forEach(b => {
        b.classList.toggle("active", b.dataset.filter === filter);
    });
}

function finishSearchUI(msg, status = "done") {
    const btn = document.getElementById("btn-search");
    const btnText = document.getElementById("btn-search-text");
    btn.disabled = false;
    btnText.textContent = "🔍 Buscar Itens";
    document.getElementById("progress-bar").style.width = "100%";
    document.getElementById("progress-label").textContent = msg;
    if (allResults.length > 0) {
        if (status === "done" || status === "cancelled") {
            const hasToAnalyze = allResults.some(r => r.status === "to_analyze");
            if (currentFilter === "all" || (!hasToAnalyze && currentFilter === "to_analyze")) {
                setFilter("all");
            } else {
                setFilter("to_analyze");
            }
        }
        saveCurrentSearchState();
        updateHistoryUI();
        showResults();
    }
}

// ── Results display ─────────────────────────────────────────────────────
function showResults() {
    show("results-section");
    updateStats();
    renderCards();
}

function updateStats() {
    const pending    = allResults.filter(r => r.status === "pending").length;
    const to_analyze = allResults.filter(r => r.status === "to_analyze").length;
    const approved   = allResults.filter(r => r.status === "approved").length;
    const rejected   = allResults.filter(r => r.status === "rejected").length;
    const withResult = allResults.filter(r => {
        const k = buildCheckKey(r);
        const cs = checkCache[k];
        return (cs && cs.status === "ok") || (r.tem_resultado && (!cs || cs.status !== "empty"));
    }).length;

    document.getElementById("results-stats").innerHTML = `
    <span><span class="dot dot-pending"></span> ${pending} pendentes</span>
    <span><span class="dot dot-to_analyze"></span> ${to_analyze} analisar</span>
    <span><span class="dot dot-approved"></span> ${approved} aprovados</span>
    <span><span class="dot dot-rejected"></span> ${rejected} rejeitados</span>
    <span><span class="dot dot-has-result"></span> ${withResult} com detalhes</span>
    <span>Total: ${allResults.length}</span>
  `;
}

function renderCards() {
    const grid = document.getElementById("items-grid");
    const search = (document.getElementById("filter-text").value || "").toLowerCase();

    const filtered = allResults.filter(item => {
        if (currentFilter !== "all" && item.status !== currentFilter) return false;

        // Filtro fixo de resultado extra
        const checkKey = buildCheckKey(item);
        const checkState = checkCache[checkKey];
        const hasResult = (checkState && checkState.status === "ok") ||
                          (Boolean(item.tem_resultado) && (!checkState || checkState.status !== "empty"));

        if (currentResultFilter === "with_result" && !hasResult) return false;
        if (currentResultFilter === "without_result" && hasResult) return false;

        if (search && !item.descricao.toLowerCase().includes(search)) return false;

        // Smart tag filter — item must contain ALL active tags (word-boundary)
        if (activeSmartTags.size > 0) {
            for (const tag of activeSmartTags) {
                if (!wordBoundaryMatch(tag, item.descricao)) return false;
            }
        }

        return true;
    });

    // Sort: "pending" items first, then treated, rejected last.
    filtered.sort((a, b) => {
        const aPending = a.status === 'pending' ? 0 : 1;
        const bPending = b.status === 'pending' ? 0 : 1;
        if (aPending !== bPending) return aPending - bPending;

        const aRejected = a.status === 'rejected' ? 1 : 0;
        const bRejected = b.status === 'rejected' ? 1 : 0;
        return aRejected - bRejected;
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
        const pageNum = getPageNumber(item);

        // Feature 2: Read badge
        const readBadge = readItems.has(idx)
            ? '<span class="badge badge-read">👁 Lido</span>'
            : '';

        // Feature 3: item label
        const itemLabel = `${escapeHtml(item.process_id)} / Item #${item.item_id}`;

        // Feature 5: Check results button state & tags
        const checkKey = buildCheckKey(item);
        const checkState = checkCache[checkKey];
        const hasFirstPassResult = Boolean(item.tem_resultado);

        let checkBtnClass = "card-btn card-btn-check";
        let checkBtnLabel = "🔍 Verificar";
        let checkTooltip = '<span class="check-tooltip">Sem resultado prévio. Clique para varrer na API.</span>';

        if (checkState) {
            if (checkState.status === "loading") {
                checkBtnClass += " check-loading";
                checkBtnLabel = "⏳ Verificando…";
                checkTooltip = '<span class="check-tooltip">Consultando API de resultados…</span>';
            } else if (checkState.status === "ok") {
                checkBtnClass += " check-ok";
                checkBtnLabel = "✓ Detalhes carregados";
                let tooltipText = "Detalhes extras confirmados";
                if (checkState.data && checkState.data.length > 0) {
                    const first = checkState.data[0];
                    const nome = first.nomeRazaoSocialFornecedor || "";
                    const val = first.valorTotalHomologado ? ` — R$ ${Number(first.valorTotalHomologado).toLocaleString('pt-BR', {minimumFractionDigits: 2})}` : "";
                    if (nome) tooltipText = `${nome}${val}`;
                }
                checkTooltip = `<span class="check-tooltip">${escapeHtml(tooltipText)}</span>`;
            } else {
                checkBtnClass += " check-empty";
                checkBtnLabel = "❌ Detalhes indisponíveis";
                checkTooltip = '<span class="check-tooltip">Sem dados adicionais na API. Clique se desejar reconsultar.</span>';
            }
        } else if (hasFirstPassResult) {
            // Detalhes extras identificados logo na 1ª filtragem
            checkBtnClass += " check-has-result";
            checkBtnLabel = "✅ Detalhes disponíveis";
            checkTooltip = '<span class="check-tooltip">Detalhes disponíveis no PNCP! Clique para carregar os dados do fornecedor.</span>';
        }

        // Badge de resultado extra no card
        const hasResultActive = (checkState && checkState.status === "ok") ||
                                (hasFirstPassResult && (!checkState || checkState.status !== "empty"));
        const resultBadge = hasResultActive
            ? '<span class="badge badge-has-result" title="O PNCP possui detalhes extras para este item">✅ Detalhes disponíveis</span>'
            : '';

        // Tag de fornecedor se já disponível
        let fornecedorTag = "";
        if (item.fornecedor && item.fornecedor !== "N/A" && item.fornecedor !== "(resultado disponível)") {
            fornecedorTag = `<span class="tag tag-fornecedor" title="Fornecedor Vencedor">👤 ${escapeHtml(item.fornecedor)}</span>`;
        } else if (checkState && checkState.status === "ok" && checkState.data && checkState.data.length > 0) {
            const fornec = checkState.data[0].nomeRazaoSocialFornecedor;
            if (fornec) {
                fornecedorTag = `<span class="tag tag-fornecedor" title="Fornecedor Vencedor">👤 ${escapeHtml(fornec)}</span>`;
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
            ${resultBadge}
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
          ${fornecedorTag}
        </div>
        <p class="card-org">${escapeHtml(item.contratante)}</p>
        <div class="card-actions">
          <button class="card-btn card-btn-approve" onclick="setStatus(${idx},'approved')">✓ Aprovar</button>
          <button class="card-btn card-btn-analyze" onclick="setStatus(${idx},'to_analyze')">🔎 Analisar</button>
          <button class="card-btn card-btn-reject"  onclick="setStatus(${idx},'rejected')">✗ Rejeitar</button>
          <button class="card-btn card-btn-open"     onclick="openProcess(${idx})" id="open-btn-${idx}">↗ Abrir</button>
          <button class="${checkBtnClass}" onclick="checkResults(${idx})" style="position:relative">${checkBtnLabel}${checkTooltip}</button>
          <button class="card-btn card-btn-copy" id="copy-btn-${idx}" onclick="copyId(event, ${idx})">📋 Copiar ID</button>
        </div>
      </div>
    `;
    }).join("");
}

// ── Actions ─────────────────────────────────────────────────────────────
function setStatus(idx, status) {
    allResults[idx].status = status;
    saveCurrentSearchState();
    updateStats();
    renderCards();
    updateHistoryUI();
}

// Feature: Deep linking with autoPage + autoItem params
function openProcess(idx) {
    readItems.add(idx);
    const item = allResults[idx];

    // Build base editais URL
    const parts = item.source_url.split("/");
    const seq  = parts.pop();
    const ano  = parts.pop();
    const cnpj = parts.pop();
    const baseUrl = `https://pncp.gov.br/app/editais/${cnpj}/${ano}/${seq}`;

    // Deep link params
    const page = getPageNumber(item);
    const deepUrl = `${baseUrl}?autoPage=${page}&autoItem=${item.item_id}`;

    window.open(deepUrl, "_blank");
    renderCards();
}

// ── Word-boundary matching helper ───────────────────────────────────────
function wordBoundaryMatch(term, text) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?<![a-zA-Z0-9])' + escaped + '(?![a-zA-Z0-9])', 'i');
    return re.test(text);
}

// Feature 3: Copy ID to clipboard — reads value from allResults (stable)
function copyId(event, idx) {
    event.stopPropagation();

    // Read from data store — avoids DOM staleness
    const item = allResults[idx];
    const text = String(item.item_id);

    const doSuccess = () => showToast('📋 ID Copiado!', 'success');

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(doSuccess).catch(() => {
            _fallbackCopy(text, doSuccess);
        });
    } else {
        _fallbackCopy(text, doSuccess);
    }
}

function _fallbackCopy(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    cb();
}

// Feature 5: Check additional results
function buildCheckKey(item) {
    const parts = item.source_url.split("/");
    const seq  = parts.pop();
    const ano  = parts.pop();
    const cnpj = parts.pop();
    return `${cnpj}/${ano}/${seq}/${item.item_id}`;
}

function checkResults(idx) {
    const item = allResults[idx];
    const checkKey = buildCheckKey(item);

    // Se já estiver em loading, previne duplo clique
    if (checkCache[checkKey] && checkCache[checkKey].status === "loading") return;

    const parts = item.source_url.split("/");
    const seq  = parts.pop();
    const ano  = parts.pop();
    const cnpj = parts.pop();

    const apiUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens/${item.item_id}/resultados`;

    checkCache[checkKey] = { status: "loading" };
    renderCards();

    fetch(`/api/check-results?url=${encodeURIComponent(apiUrl)}`)
        .then(r => r.json())
        .then(data => {
            const hasData = Boolean(data.has_data && data.data && data.data.length > 0);
            checkCache[checkKey] = {
                status: hasData ? "ok" : "empty",
                data: data.data || null,
            };

            if (hasData) {
                item.tem_resultado = true;
                item.status = "to_analyze";
                if (data.data[0] && data.data[0].nomeRazaoSocialFornecedor) {
                    item.fornecedor = data.data[0].nomeRazaoSocialFornecedor;
                }
                showToast(`✓ Detalhes carregados para Item #${item.item_id}`, 'success');
                saveCurrentSearchState();
                updateStats();
                renderCards();
                updateHistoryUI();
            } else {
                // Exclusão automática retornada se verificado manualmente com o botão
                setStatus(idx, 'rejected');
                showToast(`✗ Item #${item.item_id} movido para Recusado (sem detalhes extras)`, 'warn');
            }
        })
        .catch(() => {
            const logPanel = document.getElementById('log-panel');
            if (logPanel) {
                const div = document.createElement('div');
                div.className = 'log-error';
                div.textContent = `Erro ao verificar resultados de ${item.process_id} Item #${item.item_id}`;
                logPanel.appendChild(div);
                logPanel.scrollTop = logPanel.scrollHeight;
            }
            checkCache[checkKey] = { status: 'empty' };
            setStatus(idx, 'rejected');
            showToast(`✗ Erro na consulta — Item #${item.item_id} movido para Recusado`, 'warn');
        });
}

// Feature 4: Smart Tags — decompose new syntax into individual filter chips
function buildSmartTags(keywordsStr) {
    activeSmartTags.clear();
    const container = document.getElementById("smart-tags");
    container.innerHTML = "";

    const chips = [];
    const bracketRegex = /\[([^\]]+)\]/g;
    let m;
    while ((m = bracketRegex.exec(keywordsStr)) !== null) {
        const inner = m[1];
        const innerRegex = /\{([^}]+)\}|([^|{}]+)/g;
        let im;
        while ((im = innerRegex.exec(inner)) !== null) {
            if (im[1]) {
                im[1].split('|').forEach(alt => {
                    const t = alt.trim();
                    if (t) chips.push(t);
                });
            } else if (im[2]) {
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
    // Salva o estado da pesquisa atual antes de limpar
    saveCurrentSearchState();
    activeSearchId = null;

    // ── Hard reset: state & cache ─────────────────────────────────────────
    allResults = [];
    readItems.clear();
    activeSmartTags.clear();
    Object.keys(checkCache).forEach(k => delete checkCache[k]);

    // Stop any in-flight poll / title-flip
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    _stopTitleFlip();
    if (_activeNotification) {
        try { _activeNotification.close(); } catch (_) {}
        _activeNotification = null;
    }
    _stopTimer();
    _searchInProgress = false;
    isSearchStopped = false;
    currentJobId = null;

    // ── Hard reset: UI ────────────────────────────────────────────────────
    hide("results-section");
    hide("progress-section");

    // Filter chips & text
    document.getElementById("smart-tags").innerHTML = "";
    document.getElementById("filter-text").value = "";
    currentFilter = "all";
    document.querySelectorAll(".pill[data-filter]").forEach(b => {
        b.classList.toggle("active", b.dataset.filter === "all");
    });
    currentResultFilter = "all";
    document.querySelectorAll(".pill[data-result-filter]").forEach(b => {
        b.classList.toggle("active", b.dataset.resultFilter === "all");
    });

    // Search form fields
    document.getElementById("search-form").reset();

    // Log panel & progress bar
    const logPanel = document.getElementById("log-panel");
    if (logPanel) logPanel.innerHTML = "";
    const progressBar = document.getElementById("progress-bar");
    if (progressBar) progressBar.style.width = "0%";
    const progressLabel = document.getElementById("progress-label");
    if (progressLabel) progressLabel.textContent = "";

    // Prompt Engine: clear AI main description
    const aiDesc = document.getElementById("ai-main-desc");
    if (aiDesc) aiDesc.value = "";

    // Reset search button state
    const btn = document.getElementById("btn-search");
    const btnText = document.getElementById("btn-search-text");
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = "🔍 Buscar Itens";

    // Status panel
    _itemsVerified = 0;
    _timerStart = null;
    _updateStatusPanel();

    updateHistoryUI();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Search History in Memory Operations ──────────────────────────────────
function saveCurrentSearchState() {
    if (!activeSearchId || allResults.length === 0) return;
    const entry = searchHistory.find(h => h.id === activeSearchId);
    if (!entry) return;

    entry.results = allResults;
    entry.checkCache = { ...checkCache };
    entry.readItems = Array.from(readItems);
    entry.activeSmartTags = Array.from(activeSmartTags);
    entry.currentFilter = currentFilter;
    entry.currentResultFilter = currentResultFilter;
    entry.itemsVerified = _itemsVerified;
}

function registerNewSearch(params) {
    saveCurrentSearchState();
    const id = "search-" + Date.now();
    const entry = {
        id,
        timestamp: new Date(),
        keywords: params.keywords || "",
        params: { ...params },
        results: [],
        checkCache: {},
        readItems: [],
        activeSmartTags: [],
        currentFilter: "to_analyze",
        currentResultFilter: "all",
        itemsVerified: 0,
    };
    searchHistory.unshift(entry);
    if (searchHistory.length > MAX_SEARCH_HISTORY) {
        searchHistory.pop();
    }
    activeSearchId = id;
    updateHistoryUI();
    return entry;
}

function loadSearchFromHistory(id) {
    const entry = searchHistory.find(h => h.id === id);
    if (!entry) return;

    saveCurrentSearchState();

    activeSearchId = entry.id;
    allResults = entry.results || [];

    // Restaurar cache de checagens
    Object.keys(checkCache).forEach(k => delete checkCache[k]);
    Object.assign(checkCache, entry.checkCache || {});

    // Restaurar itens lidos
    readItems.clear();
    (entry.readItems || []).forEach(idx => readItems.add(idx));

    // Restaurar smart tags
    activeSmartTags.clear();
    (entry.activeSmartTags || []).forEach(tag => activeSmartTags.add(tag));

    _itemsVerified = entry.itemsVerified || 0;

    // Preencher campos do formulário para o usuário ver os parâmetros da busca
    const form = document.getElementById("search-form");
    if (form && entry.params) {
        if (form.keywords) form.keywords.value = entry.params.keywords || "";
        if (form.uf) form.uf.value = entry.params.uf || "";
        if (form.status) form.status.value = entry.params.status || "";
        if (form.date_from) form.date_from.value = entry.params.date_from || "";
        if (form.date_to) form.date_to.value = entry.params.date_to || "";
        if (form.contratante) form.contratante.value = entry.params.contratante || "";
        if (form.max_processes) form.max_processes.value = entry.params.max_processes || 50;
        if (form.fuzzy_threshold) form.fuzzy_threshold.value = entry.params.fuzzy_threshold || 80;
    }

    // Restaurar filtros
    currentFilter = entry.currentFilter || "to_analyze";
    currentResultFilter = entry.currentResultFilter || "all";
    document.querySelectorAll(".pill[data-filter]").forEach(b => {
        b.classList.toggle("active", b.dataset.filter === currentFilter);
    });
    document.querySelectorAll(".pill[data-result-filter]").forEach(b => {
        b.classList.toggle("active", b.dataset.resultFilter === currentResultFilter);
    });

    // Reconstruir smart tags
    buildSmartTags(entry.keywords);
    document.querySelectorAll(".smart-tag").forEach(b => {
        b.classList.toggle("active", activeSmartTags.has(b.textContent));
    });

    // Esconder seção de progresso se estiver ativa e mostrar resultados
    hide("progress-section");
    showResults();
    updateHistoryUI();
    closeHistoryModal();

    showToast(`📂 Pesquisa carregada da memória (${allResults.length} itens)`, 'info');
}

function updateHistoryUI() {
    // Contador no header
    const countEl = document.getElementById("history-count");
    if (countEl) countEl.textContent = searchHistory.length;

    // Barra de histórico
    const bar = document.getElementById("search-history-bar");
    const chipsContainer = document.getElementById("history-chips");

    if (bar && chipsContainer) {
        if (searchHistory.length === 0) {
            bar.classList.add("hidden");
            chipsContainer.innerHTML = "";
        } else {
            bar.classList.remove("hidden");
            chipsContainer.innerHTML = searchHistory.map(entry => {
                const isActive = entry.id === activeSearchId;
                const kw = escapeHtml(entry.keywords || "Busca");
                const count = (entry.results || []).length;
                const activeCls = isActive ? "active" : "";
                const ufStr = entry.params && entry.params.uf ? ` [${escapeHtml(entry.params.uf)}]` : "";
                return `<button class="history-chip ${activeCls}" onclick="loadSearchFromHistory('${entry.id}')" title="Clique para carregar esta pesquisa da memória">
                    <span>${kw}${ufStr}</span>
                    <span class="history-chip-count">${count}</span>
                </button>`;
            }).join("");
        }
    }

    // Modal de histórico
    const listContainer = document.getElementById("history-list");
    if (listContainer) {
        if (searchHistory.length === 0) {
            listContainer.innerHTML = '<p style="text-align:center;color:var(--text-dim);padding:30px">Nenhuma pesquisa salva em memória nesta sessão.</p>';
        } else {
            listContainer.innerHTML = searchHistory.map((entry) => {
                const isActive = entry.id === activeSearchId;
                const kw = escapeHtml(entry.keywords || "Sem palavras-chave");
                const total = (entry.results || []).length;
                const pending = (entry.results || []).filter(r => r.status === "pending").length;
                const toAnalyze = (entry.results || []).filter(r => r.status === "to_analyze").length;
                const approved = (entry.results || []).filter(r => r.status === "approved").length;
                const rejected = (entry.results || []).filter(r => r.status === "rejected").length;

                const timeStr = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
                const ufStr = entry.params && entry.params.uf ? `UF: <strong>${escapeHtml(entry.params.uf)}</strong>` : "UF: Todos";
                const dateStr = entry.params && entry.params.date_from ? `Início: ${escapeHtml(entry.params.date_from)}` : "";

                return `
                <div class="history-card ${isActive ? 'active' : ''}">
                    <div class="history-card-top">
                        <div style="display:flex;align-items:center;gap:8px">
                            <span class="history-card-title">${kw}</span>
                            ${isActive ? '<span class="badge" style="background:rgba(56,189,248,0.2);color:#38bdf8;font-size:0.65rem">Ativa Agora</span>' : ''}
                        </div>
                        <span class="history-card-time">🕒 ${timeStr}</span>
                    </div>
                    <div class="history-card-meta">
                        <span>${ufStr}</span>
                        ${dateStr ? `<span>${dateStr}</span>` : ''}
                        <span>Total: <strong>${total}</strong> itens</span>
                    </div>
                    <div class="history-card-stats">
                        <span class="history-stat-tag history-stat-to_analyze">🔎 ${toAnalyze} para analisar</span>
                        <span class="history-stat-tag history-stat-approved">✓ ${approved} aprovados</span>
                        <span class="history-stat-tag history-stat-pending">⏳ ${pending} pendentes</span>
                        <span class="history-stat-tag history-stat-rejected">✗ ${rejected} rejeitados</span>
                    </div>
                    <div class="history-card-actions">
                        <button class="btn-action" style="font-size:0.75rem;padding:4px 10px;border-color:#f87171;color:#f87171" onclick="deleteSearchFromHistory('${entry.id}', event)">🗑 Remover</button>
                        <button class="btn-action" style="font-size:0.75rem;padding:4px 14px;border-color:#38bdf8;color:#38bdf8" onclick="loadSearchFromHistory('${entry.id}')">👁 Carregar</button>
                    </div>
                </div>
                `;
            }).join("");
        }
    }
}

function openHistoryModal() {
    updateHistoryUI();
    document.getElementById("history-modal").classList.remove("hidden");
}

function closeHistoryModal() {
    document.getElementById("history-modal").classList.add("hidden");
}

function clearSearchHistory() {
    if (searchHistory.length === 0) return;
    if (!confirm("Deseja realmente limpar todas as pesquisas salvas da memória nesta sessão?")) return;
    searchHistory = [];
    activeSearchId = null;
    updateHistoryUI();
    closeHistoryModal();
    showToast("🗑 Histórico em memória esvaziado.", "info");
}

function deleteSearchFromHistory(id, event) {
    if (event) event.stopPropagation();
    searchHistory = searchHistory.filter(h => h.id !== id);
    if (activeSearchId === id) {
        activeSearchId = searchHistory.length > 0 ? searchHistory[0].id : null;
    }
    updateHistoryUI();
    showToast("Pesquisa removida da memória.", "info");
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

// ── Filter pills: Status ────────────────────────────────────────────────
document.querySelectorAll(".pill[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".pill[data-filter]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentFilter = btn.dataset.filter;
        renderCards();
    });
});

// ── Filter pills: Resultado Extra ───────────────────────────────────────
document.querySelectorAll(".pill[data-result-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".pill[data-result-filter]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentResultFilter = btn.dataset.resultFilter;
        renderCards();
    });
});

document.getElementById("filter-text").addEventListener("input", () => renderCards());

// ── AI Prompt Engine ─────────────────────────────────────────────────────
const SAMPLE_CABOS = `CABO de cobre com isolacao PVC 1kv 16mm2

CABO de cobre, eletrico, flexivel, cor verde, secao nominal 2,5mm², classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, isolação em PVC/A, antichama BWF-B, 1condutor de cobre eletrolitico, tempera mole. Produto exibindo o Selo de Conformidade de forma visivel, legivel, indelevel e permanente, o nome, a marca ou logotipo do fabricante, nome do produto. Sera permitido o uso por extenso do nome do Inmetro em substituicao a logomarca “do Inmetro”. Devera conter o selo de identificacao da conformidade, atender a(s) norma(s) ABNT e Portaria(s) vigente(s) do INMETRO.

CABO de cobre, eletrico, flexivel, cor preto, secao nominal 6mm², condutor de cobre, classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, tempera mole, isolado em PVC/A, antichama BWF-B. EMBALAGEM: Contendo 100 m.

CABO de cobre, eletrico, flexivel, cor azul, secao nominal 6mm², condutor de cobre, classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, tempera mole, isolado em PVC/A, antichama BWF-B. EMBALAGEM: Contendo 50 m. Devera estar exibindo o numero do REGISTRO junto ao INMETRO e o Selo de Conformidade de forma visivel, legivel, indelevel e permanente, o nome, a marca ou logotipo do fabricante, nome do produto, a secao nominal, a data de fabricacao e o lote. Atender a(s) norma(s) ABNT e Portaria(s) vigente(s) do INMETRO.

CABO de cobre, eletrico, flexivel, cor branco, secao nominal 6mm², condutor de cobre, classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, tempera mole, isolado em PVC/A, antichama BWF-B. EMBALAGEM: Contendo 100 m.

CABO de cobre, eletrico, flexivel, cor verde, secao nominal 6mm², condutor de cobre, classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, tempera mole, isolado em PVC/A, antichama BWF-B. EMBALAGEM: Contendo 100 m.

CABO de cobre, eletrico, flexivel, cor verde, secao nominal 4mm², condutor de cobre, classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, tempera mole, isolado em PVC/A, antichama BWF-B. EMBALAGEM: Contendo 100 m.

CABO de cobre, eletrico, flexivel, cor verde, secao nominal 2,5mm², classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, isolacao em PVC/A, antichama BWF-B, 1 condutor de cobre eletrolitico, tempera mole. O corpo do cabo deve apresentar as seguintes informacoes: logomarca INMETRO, numero de registro no INMETRO, logomarca ou nome do OCP, numero de identificacao do OCP; se o cabo for composto de apenas um condutor, com secao 2,5 mm² ou menor, sera permitido o uso por extenso do nome do INMETRO em substituicao a sua logomarca. EMBALAGEM: Contendo 100 m. 

CABO de cobre, eletrico, flexivel, cor azul, secao nominal 16mm², classe de encordoamento 5, classe de isolacao 450/ 750V, isolacao em PVC/A, antichama BWF-B, tempera mole. O corpo do cabo deve apresentar as seguintes informacoes: logomarca INMETRO, numero de registro no INMETRO, logomarca ou nome do OCP, numero de identificacao do OCP. EMBALAGEM: Contendo 100 m.

CABO de cobre, eletrico, flexivel, cor azul , secao nominal 2,5mm², classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, isolacao em PVC/A, antichama BWF-B, condutores de cobre eletrolitico, tempera mole. O corpo do cabo deve apresentar as seguintes informacoes: logomarca INMETRO, numero de registro no INMETRO, logomarca ou nome do OCP, numero de identificacao do OCP; se o cabo for composto de apenas um condutor, com secao 2,5 mm² ou menor, sera permitido o uso por extenso do nome do INMETRO em substituicao a sua logomarca. EMBALAGEM: Contendo 100 m.

CABO de cobre, eletrico, flexivel, cor amarelo, secao nominal 2,5mm², classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, isolacao em PVC/A, antichama BWF-B, 1 condutor de cobre eletrolitico, tempera mole. O corpo do cabo deve apresentar as seguintes informacoes: logomarca INMETRO, numero de registro no INMETRO, logomarca ou nome do OCP, numero de identificacao do OCP; se o cabo for composto de apenas um condutor, com secao 2,5 mm² ou menor, sera permitido o uso por extenso do nome do INMETRO em substituicao a sua logomarca. EMBALAGEM: Contendo 100 m. ROTULAGEM: Deve conter o Selo de Identificacao da Conformidade INMETRO, podendo ser impresso ou fixado por uma etiqueta adesiva, de forma visivel, legivel, indelevel e permanente, Nome ou marca do fabricante, Comprimento nominal (em metros), Numero de condutores e secao nominal (em mm²), Data de fabricacao e Lote. O produto devera atender a(s) seguintes legislacoes vigentes: Portaria INMETRO - Regulamento Consolidado para Fios, Cabos e Cordoes Flexiveis Eletricos, na forma do Regulamento Tecnico da Qualidade, dos Requisitos de Avaliacao da Conformidade e das Especificacoes para o Selo de Identificacao da Conformidade.

CABO de cobre, eletrico, flexivel, cor vermelho, secao nominal 4mm², classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, isolacao em PVC/A, antichama BWF-B, 1 condutor de cobre eletrolitico, tempera mole. O corpo do cabo deve apresentar as seguintes informacoes: logomarca INMETRO, numero de registro no INMETRO, logomarca ou nome do OCP, numero de identificacao do OCP. EMBALAGEM: Contendo 100 m. 

CABO de cobre, eletrico, flexivel, cor branco, secao nominal 4mm², classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, isolacao em PVC/A, antichama BWF-B, 1 condutor de cobre eletrolitico, tempera mole. O corpo do cabo deve apresentar as seguintes informacoes: logomarca INMETRO, numero de registro no INMETRO, logomarca ou nome do OCP, numero de identificacao do OCP. EMBALAGEM: Contendo 100 m. 

CABO de cobre, eletrico, flexivel, cor branco, secao nominal 2,5mm², classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, isolacaoo em PVC/A, antichama BWF-B, 1condutor de cobre eletrolitico, tempera mole. O corpo do cabo deve apresentar as seguintes informacoes: logomarca INMETRO, numero de registro no INMETRO, logomarca ou nome do OCP, numero de identificacao do OCP; se o cabo for composto de apenas um condutor, com secao 2,5 mm² ou menor, sera permitido o uso por extenso do nome do INMETRO em substituicao a sua logomarca. EMBALAGEM: Contendo 100 m. ROTULAGEM: Deve conter o Selo de Identificacao da Conformidade INMETRO, podendo ser impresso ou fixado por uma etiqueta adesiva, de forma visivel, legivel, indelevel e permanente, Nome ou marca do fabricante, Comprimento nominal (em metros), Numero de condutores e secao nominal (em mm²), Data de fabricacao e Lote. O produto devera atender a(s) seguintes legislacoes vigentes: Portaria INMETRO - Regulamento Consolidado para Fios, Cabos e Cordoes Flexiveis Eletricos, na forma do Regulamento Tecnico da Qualidade, dos Requisitos de Avaliacao da Conformidade e das Especificacoes para o Selo de Identificacao da Conformidade.

CABO, de cobre, eletrico, flexivel, cor vermelho, secao nominal 2,5mm², classe de encordoamento 4 ou 5, classe de isolacao 450/ 750V, isolado em PVC/A, antichama BWF-B, condutor de cobre, tempera mole. O corpo do cabo deve apresentar as seguintes informacoes: logomarca INMETRO, numero de registro no INMETRO, logomarca ou nome do OCP, numero de identificacao do OCP; se o cabo for composto de apenas um condutor, com secao 2,5 mm² ou menor, sera permitido o uso por extenso do nome do INMETRO em substituicao a sua logomarca. EMBALAGEM: Contendo 50 m. ROTULAGEM: Devera constar externamente ao rolo etiqueta no minimo, as seguintes informacoes tecnicas de forma legivel e indelevel e em lingua portuguesa: Selo de Identificacao da Conformidade INMETRO; Nome ou marca do fabricante, Origem da industria, Tensao de isolamento (V) ou (V0/V), em V; Numero da norma tecnica de referencia; Comprimento nominal, em m (metro); Numero de condutores e secao nominal, em mm²; Norma tecnica base para ensaios de tipo; Massa bruta, em kg; Lote e data de fabricacao. O produto devera atender a(s) seguintes legislacoes vigentes: Portaria INMETRO - Regulamento Consolidado para Fios, Cabos e Cordoes Flexiveis Eletricos, na forma do Regulamento Tecnico da Qualidade, dos Requisitos de Avaliacao da Conformidade e das Especificações para o Selo de Identificacao da Conformidade.`;

let _detectedAICategories = {}; // { "Cabo de Cobre Flexível": ["item1", ...] }
let _selectedAICategories = new Set();
let _aiInputDebounce = null;

function openAIPromptModal() {
    const modal = document.getElementById("ai-modal");
    if (modal) modal.classList.remove("hidden");
    const rawEl = document.getElementById("ai-raw-items");
    if (rawEl && rawEl.value.trim()) {
        updateDetectedCategories();
    }
    updateAICompareStatusUI();
}

function closeAIPromptModal() {
    const modal = document.getElementById("ai-modal");
    if (modal) modal.classList.add("hidden");
}

function switchAITab(tab) {
    const btnSearch = document.getElementById("tab-btn-search-prompts");
    const btnCompare = document.getElementById("tab-btn-compare-prompts");
    const contentSearch = document.getElementById("ai-tab-search-prompts");
    const contentCompare = document.getElementById("ai-tab-compare-prompts");

    if (tab === "search-prompts") {
        if (btnSearch) btnSearch.classList.add("active");
        if (btnCompare) btnCompare.classList.remove("active");
        if (contentSearch) contentSearch.classList.remove("hidden");
        if (contentCompare) contentCompare.classList.add("hidden");
    } else {
        if (btnSearch) btnSearch.classList.remove("active");
        if (btnCompare) btnCompare.classList.add("active");
        if (contentSearch) contentSearch.classList.add("hidden");
        if (contentCompare) contentCompare.classList.remove("hidden");
        updateAICompareStatusUI();
    }
}

function loadSampleCabos() {
    const el = document.getElementById("ai-raw-items");
    if (el) {
        el.value = SAMPLE_CABOS;
        updateDetectedCategories();
        showToast("✨ 15 itens de cabos de exemplo carregados!", "info");
    }
}

function clearAISearchItems() {
    const el = document.getElementById("ai-raw-items");
    if (el) el.value = "";
    _detectedAICategories = {};
    _selectedAICategories.clear();
    updateDetectedCategories();
    const out = document.getElementById("ai-output-container");
    if (out) out.classList.add("hidden");
}

function importItemsFromCurrentSearch() {
    if (!allResults || allResults.length === 0) {
        showToast("Nenhum item na busca atual para importar.", "warn");
        return;
    }

    let targetItems = allResults.filter(r => r.status === "to_analyze" || r.status === "approved");
    if (targetItems.length === 0) targetItems = allResults;

    const descriptions = targetItems.map(r => r.descricao).filter(d => d && d.trim());
    if (descriptions.length === 0) {
        showToast("Nenhuma descrição encontrada nos itens da busca.", "warn");
        return;
    }

    const el = document.getElementById("ai-raw-items");
    if (el) {
        el.value = descriptions.join("\n\n");
        updateDetectedCategories();
        showToast(`📥 ${descriptions.length} itens importados da busca atual!`, "success");
    }
}

function classifyItemDescription(rawText) {
    if (!rawText) return "Geral";
    const text = rawText.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[,;:\-\–\—\(\)\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    // 1. Cabos / Condutores elétricos
    if (text.includes("cabo") || text.includes("fio ") || text.includes("condutor")) {
        const isCobre = text.includes("cobre");
        const base = isCobre ? "Cabo de Cobre" : "Cabo Elétrico";
        if (text.includes("flexivel")) return `${base} Flexível`;
        if (text.includes("1kv") || text.includes("1 kv") || text.includes("isolacao pvc")) return `${base} 1kV / Isolado`;
        if (text.includes("multiplexado")) return `${base} Multiplexado`;
        if (text.includes("rigido")) return `${base} Rígido`;
        if (text.includes("rede") || text.includes("cat6") || text.includes("cat5") || text.includes("utp")) return "Cabo de Rede / UTP";
        return base;
    }

    // 2. Disjuntores
    if (text.includes("disjuntor")) {
        if (text.includes("bipolar")) return "Disjuntor Bipolar";
        if (text.includes("tripolar")) return "Disjuntor Tripolar";
        if (text.includes("monopolar") || text.includes("unipolar")) return "Disjuntor Monopolar";
        if (text.includes("caixa moldada")) return "Disjuntor Caixa Moldada";
        return "Disjuntores";
    }

    // 3. Lâmpadas / Iluminação
    if (text.includes("lampada") || text.includes("luminaria") || text.includes("refletor")) {
        if (text.includes("led") && text.includes("tubular")) return "Lâmpada LED Tubular";
        if (text.includes("led")) return "Iluminação LED";
        return "Iluminação";
    }

    // 4. Eletrodutos / Tubulações
    if (text.includes("eletroduto") || text.includes("tubo")) {
        if (text.includes("pvc")) return "Eletroduto / Tubo PVC";
        if (text.includes("galvanizado") || text.includes("aco")) return "Eletroduto Metálico";
        return "Eletrodutos";
    }

    // 5. Fallback baseado nos primeiros termos significativos
    const stopWords = new Set(["de", "com", "em", "para", "a", "o", "as", "os", "do", "da", "dos", "das", "um", "uma", "cor", "secao", "nominal", "tipo", "marca", "unidade"]);
    const words = text.split(" ").filter(w => w.length > 2 && !stopWords.has(w) && !/^\d+/.test(w));
    if (words.length >= 2) {
        return words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    }
    if (words.length === 1) {
        return words[0].charAt(0).toUpperCase() + words[0].slice(1);
    }
    return "Outros / Diversos";
}

function parseItemsAndCategories(rawText) {
    const lines = (rawText || "").split(/\r?\n/);
    const categories = {};
    let currentCat = null;
    let currentItem = "";
    let totalItems = 0;

    function flushItem() {
        const trimmed = currentItem.trim();
        if (trimmed) {
            const cat = currentCat || classifyItemDescription(trimmed);
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(trimmed);
            totalItems++;
        }
        currentItem = "";
    }

    for (let line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
            flushItem();
            continue;
        }

        // Cabeçalhos explícitos de categoria: "# Cabos", "[Cabos]", "Categoria: Cabos"
        const headerMatch = trimmedLine.match(/^(?:#+\s*|\[|Categoria:\s*)([^\]#\n]+)(?:\])?$/i);
        if (headerMatch && !trimmedLine.includes(";") && trimmedLine.length < 50 && !trimmedLine.toLowerCase().startsWith("cabo de cobre")) {
            flushItem();
            currentCat = headerMatch[1].trim();
            continue;
        }

        // Itens que começam com numeração ou marcador de lista
        if (/^(?:\d+[\.\-\)]\s*|item\s*\d+[:\-]\s*|[\*\-]\s*)/i.test(trimmedLine)) {
            flushItem();
            currentItem = trimmedLine.replace(/^(?:\d+[\.\-\)]\s*|item\s*\d+[:\-]\s*|[\*\-]\s*)/i, "");
        } else if (currentItem) {
            currentItem += " " + trimmedLine;
        } else {
            currentItem = trimmedLine;
        }
    }
    flushItem();

    return { categories, totalItems };
}

function onAIRawItemsInput() {
    clearTimeout(_aiInputDebounce);
    _aiInputDebounce = setTimeout(updateDetectedCategories, 250);
}

function updateDetectedCategories() {
    const rawEl = document.getElementById("ai-raw-items");
    const raw = rawEl ? rawEl.value : "";
    const { categories, totalItems } = parseItemsAndCategories(raw);
    _detectedAICategories = categories;

    const catNames = Object.keys(categories);
    const catCountEl = document.getElementById("ai-cat-count");
    const itemCountEl = document.getElementById("ai-item-count");
    if (catCountEl) catCountEl.textContent = catNames.length;
    if (itemCountEl) itemCountEl.textContent = `${totalItems} ${totalItems === 1 ? 'item' : 'itens'}`;

    // Sincroniza _selectedAICategories: mantém as já selecionadas ou seleciona todas novas
    const newSelected = new Set();
    catNames.forEach(name => {
        if (_selectedAICategories.has(name) || _selectedAICategories.size === 0) {
            newSelected.add(name);
        }
    });
    _selectedAICategories = newSelected;

    const container = document.getElementById("ai-category-chips");
    if (!container) return;

    if (catNames.length === 0) {
        container.innerHTML = `<span style="font-size:0.78rem;color:var(--text-dim);">Cole itens acima ou clique em 'Exemplo Cabos' para detectar categorias.</span>`;
        return;
    }

    container.innerHTML = catNames.map(name => {
        const isChecked = _selectedAICategories.has(name);
        const count = categories[name].length;
        const activeCls = isChecked ? "active" : "";
        return `
            <label class="ai-cat-chip ${activeCls}" title="Clique para selecionar ou desmarcar esta categoria">
                <input type="checkbox" ${isChecked ? "checked" : ""} onchange="toggleAICategory('${escapeHtml(name)}')">
                <span>${escapeHtml(name)}</span>
                <span class="ai-cat-count">${count}</span>
            </label>
        `;
    }).join("");
}

function toggleAICategory(catName) {
    if (_selectedAICategories.has(catName)) {
        _selectedAICategories.delete(catName);
    } else {
        _selectedAICategories.add(catName);
    }
    updateDetectedCategories();
}

function toggleAllAICategories(selectAll) {
    _selectedAICategories.clear();
    if (selectAll) {
        Object.keys(_detectedAICategories).forEach(k => _selectedAICategories.add(k));
    }
    updateDetectedCategories();
}

function buildAIPromptTemplate(formattedItemsText) {
    return `Gere strings de busca para que meu bot busque pelos itens no portal do PNCP. Tente agrupar o máximo de itens por string, pode gerar varias strings separadas sempre que necessário.

Instruções de uso: [📖 Guia de Busca

Sintaxe Geral
Termo Base [Filtro Simples | {Opção A | Opção B} | {Opção 1 | Opção 2}]

Hierarquia de Obrigatoriedade:
- Termo Base: ⚠️ Obrigatório. Todas as palavras devem existir na descrição. Exemplo: cabo de cobre
- [Filtro Simples]: ⚠️ Obrigatório. O termo deve existir no item. Exemplo: [flexivel]
- [{A | B}]: ⚠️ Obrigatório (OR interno). Pelo menos UM dos termos dentro das chaves deve existir. Exemplo: {vermelho | azul}

Exemplo Prático:
cabo de cobre [flexivel | {vermelho | azul} | {2,5mm | 1,5mm}]

Descrição do Item | Resultado | Motivo
- Cabo de Cobre Flexível Azul 2,5mm | ✅ Aprovado | Atende a todos os critérios e grupos.
- Cabo de Cobre Flexível Verde 2,5mm | ❌ Rejeitado | Possui "Flexível" e "2,5mm", mas não possui "Vermelho" nem "Azul".
- Cabo de Cobre Azul 1,5mm (sem "Flexível") | ❌ Rejeitado | Falta o termo obrigatório "Flexível".
- Cano de Cobre Azul 1,5mm | ❌ Rejeitado | Não atende ao termo base "cabo de cobre".

💡 Dica: Buscas Mais Amplas
Se quiser resultados menos restritivos, remova os grupos de chaves { } ou os filtros dentro de [ ]. Quanto mais filtros você define, mais cirúrgica é a busca.

Ordenação dos Resultados:
Itens Pendentes (não revisados) aparecem sempre no topo. Itens já tratados (Aprovados, Para Analisar) vão ao final. Rejeitados ficam sempre por último.

Regras de Otimização e Agrupamento:
1. Agrupe variações de um mesmo produto usando grupos com chaves '{ Opção 1 | Opção 2 | ... }' para características variáveis (como cores, bitolas/seções nominais, tensões, etc.).
2. O termo base (fora dos colchetes) deve conter apenas o nome comum principal do produto (ex: 'cabo de cobre', 'disjuntor', etc.).
3. Dentro dos colchetes '[ ... ]', use filtros simples para características obrigatórias (ex: 'flexivel') e chaves '{ ... }' separadas por pipe '|' para alternativas.
4. Separe em strings distintas quando os itens forem de categorias ou especificações incompatíveis.
5. O resultado esperado é algo como:
   'cabo de cobre [flexivel | {2,5mm | 4mm | 6mm | 16mm} | {verde | preto | azul | branco | amarelo | vermelho}]'
   'cabo de cobre [1kv | {16mm2 | 16mm}]'
]

Descrição dos itens: [
${formattedItemsText}
]

Forneça as strings de busca otimizadas resultantes no formato exato acima, prontas para colar no campo de busca do bot.`;
}

function generateSearchStringsPrompt() {
    const rawEl = document.getElementById("ai-raw-items");
    const raw = rawEl ? rawEl.value.trim() : "";
    if (!raw) {
        showToast("Cole as descrições dos itens antes de gerar o prompt.", "warn");
        return;
    }

    const { categories, totalItems } = parseItemsAndCategories(raw);
    _detectedAICategories = categories;

    const selectedCats = Object.keys(categories).filter(c => _selectedAICategories.has(c));
    if (selectedCats.length === 0) {
        showToast("Selecione pelo menos uma categoria para gerar.", "warn");
        return;
    }

    const mode = document.querySelector('input[name="ai-generation-mode"]:checked')?.value || "combined";
    const outputContainer = document.getElementById("ai-output-container");
    const outputTitle = document.getElementById("ai-output-title");
    const outputActions = document.getElementById("ai-output-actions");
    const outputBody = document.getElementById("ai-output-body");

    if (!outputContainer) return;
    outputContainer.classList.remove("hidden");

    if (mode === "combined") {
        // MODO EM CONJUNTO
        let itemsBlock = "";
        let selectedTotalItems = 0;
        selectedCats.forEach((catName, idx) => {
            const list = categories[catName];
            selectedTotalItems += list.length;
            itemsBlock += `\n### Categoria ${idx + 1}: ${catName} (${list.length} itens)\n`;
            list.forEach((item, itemIdx) => {
                itemsBlock += `${itemIdx + 1}. ${item}\n\n`;
            });
        });

        const fullPrompt = buildAIPromptTemplate(itemsBlock.trim());

        if (outputTitle) {
            outputTitle.innerHTML = `📋 Prompt Unificado (${selectedCats.length} ${selectedCats.length === 1 ? 'categoria' : 'categorias'} • ${selectedTotalItems} itens)`;
        }
        if (outputActions) {
            outputActions.innerHTML = `
                <button class="btn-action" style="font-size:0.75rem;padding:4px 14px;border-color:#38bdf8;color:#38bdf8;" onclick="copyAIPromptText('combined')">📋 Copiar Prompt Unificado</button>
            `;
        }
        if (outputBody) {
            outputBody.innerHTML = `<pre class="ai-output-pre" id="ai-output-text-combined">${escapeHtml(fullPrompt)}</pre>`;
        }

        // Copia automaticamente para a área de transferência
        copyAIPromptText('combined');

    } else {
        // MODO SEPARADAMENTE POR CATEGORIA
        window._aiPromptsByCat = {};
        let allPromptsText = "";

        const cardsHtml = selectedCats.map((catName, idx) => {
            const list = categories[catName];
            let itemsBlock = "";
            list.forEach((item, itemIdx) => {
                itemsBlock += `${itemIdx + 1}. ${item}\n\n`;
            });

            const catPrompt = buildAIPromptTemplate(itemsBlock.trim());
            const catKey = `cat_${idx}`;
            window._aiPromptsByCat[catKey] = catPrompt;
            allPromptsText += `\n=========================================\nCATEGORIA: ${catName.toUpperCase()} (${list.length} itens)\n=========================================\n\n${catPrompt}\n\n`;

            return `
                <div class="ai-cat-card">
                    <div class="ai-cat-card-top">
                        <span class="ai-cat-card-title">🏷 ${escapeHtml(catName)} (${list.length} ${list.length === 1 ? 'item' : 'itens'})</span>
                        <button class="btn-action" style="font-size:0.72rem;padding:3px 10px;border-color:#c084fc;color:#c084fc;" onclick="copyAIPromptText('${catKey}')">📋 Copiar Categoria</button>
                    </div>
                    <pre class="ai-output-pre" style="max-height:160px;">${escapeHtml(catPrompt)}</pre>
                </div>
            `;
        }).join("");

        window._aiPromptsByCat['all_separate'] = allPromptsText.trim();

        if (outputTitle) {
            outputTitle.innerHTML = `📋 Prompts Individuais (${selectedCats.length} categorias)`;
        }
        if (outputActions) {
            outputActions.innerHTML = `
                <button class="btn-action" style="font-size:0.75rem;padding:4px 12px;border-color:#38bdf8;color:#38bdf8;" onclick="copyAIPromptText('all_separate')">📋 Copiar Todos Juntos</button>
            `;
        }
        if (outputBody) {
            outputBody.innerHTML = `<div class="ai-cat-card-list">${cardsHtml}</div>`;
        }

        if (selectedCats.length === 1) {
            copyAIPromptText('cat_0');
        } else {
            showToast(`✨ ${selectedCats.length} prompts gerados! Copie individualmente ou todos juntos.`, "info");
        }
    }

    outputContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function copyAIPromptText(key) {
    let textToCopy = "";
    if (key === "combined") {
        textToCopy = document.getElementById("ai-output-text-combined")?.textContent || "";
    } else if (window._aiPromptsByCat && window._aiPromptsByCat[key]) {
        textToCopy = window._aiPromptsByCat[key];
    }

    if (!textToCopy) return;

    const doSuccess = () => showToast('🤖 Prompt Copiado para a Área de Transferência!', 'success');

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCopy).then(doSuccess).catch(() => {
            _fallbackCopy(textToCopy, doSuccess);
        });
    } else {
        _fallbackCopy(textToCopy, doSuccess);
    }
}

// ── AI Compare Prompt Engine ────────────────────────────────────────────
let _selectedCompareStatuses = new Set(["to_analyze", "approved"]);
let _userTouchedCompareStatuses = false;

function updateAICompareStatusUI() {
    const container = document.getElementById("ai-compare-status-chips");
    const summaryEl = document.getElementById("ai-compare-count-summary");
    if (!container) return;

    const counts = {
        to_analyze: allResults.filter(r => r.status === "to_analyze").length,
        approved:   allResults.filter(r => r.status === "approved").length,
        pending:    allResults.filter(r => r.status === "pending").length,
        rejected:   allResults.filter(r => r.status === "rejected").length,
    };

    // If default selection has 0 items but pending items exist and user hasn't manually changed selection, include pending
    if (counts.to_analyze === 0 && counts.approved === 0 && counts.pending > 0 && !_userTouchedCompareStatuses) {
        _selectedCompareStatuses.add("pending");
    }

    const statusDefs = [
        { key: "to_analyze", label: "🔎 Para Analisar", count: counts.to_analyze },
        { key: "approved",   label: "✓ Aprovados",     count: counts.approved },
        { key: "pending",    label: "⏳ Pendentes",     count: counts.pending },
        { key: "rejected",   label: "✗ Rejeitados",    count: counts.rejected },
    ];

    let totalSelected = 0;
    statusDefs.forEach(def => {
        if (_selectedCompareStatuses.has(def.key)) {
            totalSelected += def.count;
        }
    });

    if (summaryEl) {
        if (allResults.length === 0) {
            summaryEl.textContent = "0 itens (nenhuma busca ativa)";
        } else {
            summaryEl.textContent = `${totalSelected} ${totalSelected === 1 ? 'item selecionado' : 'itens selecionados'}`;
        }
    }

    container.innerHTML = statusDefs.map(def => {
        const isChecked = _selectedCompareStatuses.has(def.key);
        const activeCls = isChecked ? `active status-${def.key}` : "";
        return `
            <label class="ai-compare-chip ${activeCls}" title="Clique para alternar inclusão dos itens '${def.label}'">
                <input type="checkbox" ${isChecked ? "checked" : ""} onchange="toggleCompareStatus('${def.key}')">
                <span>${def.label}</span>
                <span class="ai-cat-count">${def.count}</span>
            </label>
        `;
    }).join("");
}

function toggleCompareStatus(status) {
    _userTouchedCompareStatuses = true;
    if (_selectedCompareStatuses.has(status)) {
        _selectedCompareStatuses.delete(status);
    } else {
        _selectedCompareStatuses.add(status);
    }
    updateAICompareStatusUI();
}

function generateAIComparePrompt() {
    const mainDesc = document.getElementById("ai-main-desc").value.trim();
    if (!mainDesc) {
        showToast("Por favor, insira a descrição principal para comparação.", "warn");
        document.getElementById("ai-main-desc")?.focus();
        return;
    }

    if (allResults.length === 0) {
        showToast("Nenhum item na busca atual. Realize uma pesquisa primeiro.", "warn");
        return;
    }

    if (_selectedCompareStatuses.size === 0) {
        showToast("Selecione pelo menos uma categoria/status para comparação.", "warn");
        return;
    }

    const itemsForAI = allResults
        .filter(r => _selectedCompareStatuses.has(r.status))
        .map(r => ({
            id: r.item_id ? String(r.item_id) : r.process_id,
            status: r.status === "to_analyze" ? "Para Analisar" : (r.status === "approved" ? "Aprovado" : (r.status === "pending" ? "Pendente" : "Rejeitado")),
            descricao: r.descricao,
            valor: (r.valor_unitario || r.valor_total) ? formatCurrency(r.valor_unitario || r.valor_total) : undefined,
            contratante: r.contratante || undefined
        }));

    if (itemsForAI.length === 0) {
        showToast("⚠ Nenhum item encontrado com os status selecionados na busca atual.", "warn");
        return;
    }

    const format = document.querySelector('input[name="ai-compare-format"]:checked')?.value || "json";
    let outputStr = "";

    if (format === "json") {
        const payload = {
            pergunta: "Alguma das descrições abaixo atende aos critérios da Descrição Principal?",
            descricao_principal: mainDesc,
            status_incluidos: Array.from(_selectedCompareStatuses).map(s => s === "to_analyze" ? "Para Analisar" : (s === "approved" ? "Aprovado" : (s === "pending" ? "Pendente" : "Rejeitado"))),
            total_itens: itemsForAI.length,
            itens_para_analise: itemsForAI,
            instrucao: "Analise cada item e responda indicando o ID do item, se atende tecnicamente (Compatível / Incompatível) e a justificativa técnica detalhada."
        };
        outputStr = JSON.stringify(payload, null, 2);
    } else {
        outputStr = `Você é um especialista em contratações públicas e análise técnica de editais.\n\n`;
        outputStr += `DESCRIÇÃO PRINCIPAL DE REFERÊNCIA:\n"${mainDesc}"\n\n`;
        outputStr += `INSTRUÇÃO DE ANÁLISE:\nAnalise os ${itemsForAI.length} itens abaixo e determine quais deles atendem tecnicamente aos critérios da Descrição Principal. Para cada item, informe o ID, veredito (Compatível / Incompatível) e justificativa técnica objetiva.\n\n`;
        outputStr += `ITENS PARA ANÁLISE (${itemsForAI.length} itens):\n`;
        itemsForAI.forEach((it, idx) => {
            outputStr += `\n[Item ${idx + 1}] ID: ${it.id} | Status: ${it.status}${it.valor ? ` | Valor: ${it.valor}` : ''}${it.contratante ? ` | Órgão: ${it.contratante}` : ''}\n`;
            outputStr += `Descrição: ${it.descricao}\n`;
        });
    }

    const outContainer = document.getElementById("ai-compare-output-container");
    const outPre = document.getElementById("ai-compare-output-pre");
    const outTitle = document.getElementById("ai-compare-output-title");

    if (outContainer) outContainer.classList.remove("hidden");
    if (outTitle) {
        outTitle.textContent = `📋 Prompt de Comparação Gerado (${itemsForAI.length} itens • ${format === 'json' ? 'JSON' : 'Texto'}):`;
    }
    if (outPre) outPre.textContent = outputStr;

    copyAICompareText();
}

function copyAICompareText() {
    const textToCopy = document.getElementById("ai-compare-output-pre")?.textContent || "";
    if (!textToCopy) return;

    const doSuccess = () => showToast('🤖 Prompt de Comparação Copiado!', 'success');

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCopy).then(doSuccess).catch(() => {
            _fallbackCopy(textToCopy, doSuccess);
        });
    } else {
        _fallbackCopy(textToCopy, doSuccess);
    }
}

function generateAIPrompt() {
    generateAIComparePrompt();
}

// ── Tampermonkey Script ──────────────────────────────────────────────────
const TAMPERMONKEY_SCRIPT = `// ==UserScript==
// @name         Automação PNCP - Paginação e Clique (Virtual Scroll Fix)
// @namespace    http://tampermonkey.net/
// @version      1.8.0
// @description  Suporte a SPA (Angular) com bypass de Virtual Scrolling
// @match        *://pncp.gov.br/*
// @grant        window.onurlchange
// @author       github.com/ruantsdo
// ==/UserScript==

(function() {
    'use strict';

    const style = document.createElement('style');
    style.innerHTML = \`
        .ng-dropdown-panel .ng-dropdown-panel-items .ng-option.ng-option-marked {
            background-color: #e6f7ff !important; color: #005fcc !important; font-weight: bold;
        }
    \`;
    document.head.appendChild(style);

    let executando = false;
    const esperar = ms => new Promise(res => setTimeout(res, ms));

    const simularClique = el => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    };

    const aguardarElemento = (seletor, timeout = 15000) => {
        return new Promise((resolve, reject) => {
            const inicio = Date.now();
            const timer = setInterval(() => {
                const el = document.querySelector(seletor);
                if (el) {
                    clearInterval(timer); resolve(el);
                } else if (Date.now() - inicio > timeout) {
                    clearInterval(timer); reject(\`[Tampermonkey] Timeout: \${seletor}\`);
                }
            }, 500);
        });
    };

    const aguardarPainelAberto = (timeout = 5000) => {
        return new Promise((resolve, reject) => {
            const inicio = Date.now();
            const timer = setInterval(() => {
                const painel = document.querySelector('.ng-dropdown-panel-items');
                if (painel) {
                    clearInterval(timer); resolve(painel);
                } else if (Date.now() - inicio > timeout) {
                    clearInterval(timer); reject(\`[Tampermonkey] Painel do ng-select não abriu.\`);
                }
            }, 100);
        });
    };

    const varrerEClicarItemPainel = (painel, textoBuscado) => {
        return new Promise((resolve) => {
            let alturaAnterior = -1;

            const intervaloScroll = setInterval(() => {
                const opcao = Array.from(painel.querySelectorAll('.ng-option'))
                    .find(opt => opt.innerText.trim() === String(textoBuscado));

                if (opcao) {
                    clearInterval(intervaloScroll);
                    opcao.scrollIntoView({ behavior: 'auto', block: 'center' });
                    setTimeout(() => { opcao.click(); resolve(true); }, 50);
                    return;
                }

                painel.scrollTop += painel.clientHeight;

                if (painel.scrollTop === alturaAnterior) {
                    clearInterval(intervaloScroll);
                    console.warn(\`[Tampermonkey] Opção '\${textoBuscado}' não existe na lista.\`);
                    document.body.click(); 
                    resolve(false);
                }
                
                alturaAnterior = painel.scrollTop;

            }, 150);
        });
    };

    const selecionarOpcao = async (selectIndex, textoBuscado) => {
        const selects = document.querySelectorAll('ng-select');
        if (selects.length <= selectIndex) return false;

        simularClique(selects[selectIndex].querySelector('.ng-select-container'));

        try {
            const painel = await aguardarPainelAberto();
            return await varrerEClicarItemPainel(painel, textoBuscado);
        } catch (erro) {
            console.error(erro);
            return false;
        }
    };

    const alterarPaginacao = async (pagina) => {
        console.log(\`[Tampermonkey] Ajustando paginação\`);
        await selecionarOpcao(0, '50');
        await esperar(500);
        await selecionarOpcao(1, pagina);
    };

    const aguardarEClicarItem = (idItem, timeout = 20000) => {
        console.log(\`[Tampermonkey] Monitorando tabela: item \${idItem}\`);
        return new Promise((resolve, reject) => {
            const inicio = Date.now();
            const timer = setInterval(() => {
                const linhas = document.querySelectorAll('datatable-body-row');
                for (const linha of linhas) {
                    const celulaId = linha.querySelector('datatable-body-cell:first-child');
                    if (celulaId && celulaId.innerText.trim() === String(idItem)) {
                        const btn = linha.querySelector('button[aria-label="Detalhar"]');
                        if (btn) {
                            btn.click();
                            clearInterval(timer);
                            console.log(\`[Tampermonkey] Item \${idItem} encontrado\`);
                            resolve(true);
                            return;
                        }
                    }
                }

                if (Date.now() - inicio > timeout) {
                    clearInterval(timer);
                    console.warn(\`[Tampermonkey] Item \${idItem} não encontrado\`);
                    reject(false);
                }
            }, 1000);
        });
    };

    const verificarEExecutar = async () => {
        if (!window.location.href.includes('/app/editais/') || executando) return;

        const params = new URLSearchParams(window.location.search);
        const autoPage = params.get('autoPage');
        const autoItem = params.get('autoItem');

        if (autoPage && autoItem) {
            executando = true;
            console.log("[Tampermonkey] Iniciando automação");

            window.history.replaceState({}, document.title, window.location.pathname);

            await esperar(1500); 

            try {
                await aguardarElemento('ng-select');
                await alterarPaginacao(autoPage);
                await aguardarEClicarItem(autoItem);
            } catch (erro) {
                console.warn(erro);
            } finally {
                executando = false;
            }
        }
    };

    verificarEExecutar();

    if (window.onurlchange === null) {
        window.addEventListener('urlchange', verificarEExecutar);
    }
})();`;

function copyTampermonkeyScript() {
    const btn = document.getElementById("btn-copy-script");
    const origText = btn ? btn.textContent : "";

    const doSuccess = () => {
        if (btn) {
            btn.textContent = "✓ Script Copiado!";
            btn.classList.add("copy-success");
            setTimeout(() => {
                btn.textContent = origText;
                btn.classList.remove("copy-success");
            }, 2000);
        }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(TAMPERMONKEY_SCRIPT).then(doSuccess).catch(() => _fallbackCopy(TAMPERMONKEY_SCRIPT, doSuccess));
    } else {
        _fallbackCopy(TAMPERMONKEY_SCRIPT, doSuccess);
    }
}
