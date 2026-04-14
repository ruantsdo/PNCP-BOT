// ── PNCP API URL Constants (mirrors config.py) ───────────────────────────────
const PNCP_SEARCH_URL    = "https://pncp.gov.br/api/search/";
const PNCP_ITEMS_URL     = (cnpj, ano, seq) =>
    `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens`;
const PNCP_COUNT_URL     = (cnpj, ano, seq) =>
    `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens/quantidade`;

// ── Fetch configuration ───────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS      = 20_000;       // 20 s per request
const FETCH_RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);
const FETCH_MAX_RETRIES     = 3;
const FETCH_BACKOFF_BASE_MS = 2_000;        // 2 s → 4 s → 8 s

// ── Native Fuzzy Match ─────────────────────────────────────────────────────────
function levenshteinDistance(s1, s2) {
    if (s1.length === 0) return s2.length;
    if (s2.length === 0) return s1.length;
    let matrix = [];
    for (let i = 0; i <= s2.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= s1.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= s2.length; i++) {
        for (let j = 1; j <= s1.length; j++) {
            if (s2.charAt(i - 1) == s1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(
                        matrix[i][j - 1] + 1, // insertion
                        matrix[i - 1][j] + 1  // deletion
                    )
                );
            }
        }
    }
    return matrix[s2.length][s1.length];
}

function partialRatio(term, text) {
    if (text.includes(term)) return 100;
    if (term.length > text.length) {
        const dist = levenshteinDistance(term, text);
        return Math.max(0, 100 - (dist / Math.max(term.length, text.length)) * 100);
    }
    
    let maxScore = 0;
    for (let i = 0; i <= text.length - term.length; i++) {
        const window = text.substring(i, i + term.length);
        const dist = levenshteinDistance(term, window);
        const score = Math.max(0, 100 - (dist / term.length) * 100);
        if (score > maxScore) {
            maxScore = score;
            if (maxScore === 100) break;
        }
    }
    return maxScore;
}

// ── Normalization & Parsing ────────────────────────────────────────────────────
function normalizeStr(text) {
    if (!text) return "";
    let s = text.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
        .replace(/\s+/g, ' ')
        .trim();
    // Normalise area units: PNCP writes mm² as 'mm2' (e.g. '2,5mm2' means 2.5 mm²)
    // Strip trailing '2' so '2,5mm2' → '2,5mm' and matches filter '2,5mm'
    s = s.replace(/(\d)mm2\b/gi, '$1mm');
    return s;
}

function parseKeywords(raw) {
    const keywords = [];
    const parts = raw.split(/,\s*(?![^\[]*\])/);
    
    parts.forEach(part => {
        part = part.trim();
        if (!part) return;
        
        const groups = [];
        const regexOuter = /\[([^\]]+)\]/g;
        let mOuter;
        while ((mOuter = regexOuter.exec(part)) !== null) {
            const inner = mOuter[1];
            const regexInner = /\{([^}]+)\}|([^|{}]+)/g;
            let mInner;
            while ((mInner = regexInner.exec(inner)) !== null) {
                if (mInner[1]) {
                    const alts = mInner[1].split('|').map(x => normalizeStr(x.trim())).filter(x => x);
                    if (alts.length > 0) groups.push(alts);
                } else if (mInner[2]) {
                    const val = normalizeStr(mInner[2].trim());
                    if (val) groups.push([val]);
                }
            }
        }
        
        const base = normalizeStr(part.replace(/\[[^\]]*\]/g, "").trim());
        if (base) {
            keywords.push({ term: base, groups });
        }
    });
    return keywords;
}

// ── Robust Fetch Helper ────────────────────────────────────────────────────────
/**
 * Wraps the /api/proxy endpoint with:
 *   - AbortController-based timeout (FETCH_TIMEOUT_MS)
 *   - Exponential-backoff retry for retryable HTTP status codes
 *   - Clear error messages distinguishing timeout vs API error
 */
async function fetchProxy(url, params = {}) {
    const searchParams = new URLSearchParams();
    searchParams.append("url", url);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") {
            searchParams.append(k, v);
        }
    }
    const proxyUrl = `/api/proxy?${searchParams.toString()}`;

    let lastError;
    for (let attempt = 1; attempt <= FETCH_MAX_RETRIES + 1; attempt++) {
        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const resp = await fetch(proxyUrl, { signal: controller.signal });
            clearTimeout(timerId);

            if (resp.ok) {
                return await resp.json();
            }

            // Transient server error — maybe retry
            if (FETCH_RETRYABLE_CODES.has(resp.status) && attempt <= FETCH_MAX_RETRIES) {
                const delay = FETCH_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                lastError = new Error(`Erro na API (${resp.status}) ao acessar ${url}`);
                await _sleep(delay);
                continue;
            }

            throw new Error(`Erro na API (${resp.status}) ao acessar ${url}`);
        } catch (err) {
            clearTimeout(timerId);
            if (err.name === "AbortError") {
                lastError = new Error(`Timeout (${FETCH_TIMEOUT_MS / 1000}s) ao acessar ${url}`);
            } else if (err.message.startsWith("Erro na API") || err.message.startsWith("Timeout")) {
                lastError = err;
            } else {
                lastError = new Error(`Erro de rede ao acessar ${url}: ${err.message}`);
            }

            // Only retry on timeout/network issues, not on already-classified API errors
            if (attempt <= FETCH_MAX_RETRIES && !(err.message.startsWith("Erro na API"))) {
                const delay = FETCH_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                await _sleep(delay);
                continue;
            }
            throw lastError;
        }
    }
    throw lastError;
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Local Extraction Pipeline ──────────────────────────────────────────────────
async function runLocalExtraction(params, logCallback, progressCallback) {
    const parsed = parseKeywords(params.keywords);
    if (parsed.length === 0) {
        throw new Error("Nenhuma palavra-chave válida informada.");
    }
    
    allResults = [];
    
    function localWordBoundaryMatch(term, text) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('(?<![a-zA-Z0-9])' + escaped + '(?![a-zA-Z0-9])', 'i');
        return re.test(text);
    }

    function checkMatchStatus(kw, normDesc) {
        // 1) Base term: ALL words must exist as word-boundary tokens
        const words = kw.term.split(' ');
        let base_ok = words.every(w => localWordBoundaryMatch(w, normDesc));

        // Fuzzy fallback — only for single-token terms long enough to avoid noise
        if (!base_ok && kw.term.length >= 5 && kw.groups.length === 0) {
            base_ok = partialRatio(kw.term, normDesc) >= params.fuzzy_threshold;
        }
        
        if (!base_ok) return null;
        
        // 2) Groups: ALL groups are now MANDATORY.
        //    Each group is an OR set — at least one alt per group must match.
        //    If ANY group fails → item is discarded (return null).
        let groupsMet = 0;
        
        for (const g of kw.groups) {
            const hasAlt = g.some(alt => localWordBoundaryMatch(alt, normDesc));
            if (!hasAlt) return null; // strict: group not satisfied → discard
            groupsMet++;
        }
        
        return {
            keyword: kw,
            groups_met: groupsMet,
            groups_unmet: 0  // zero by definition (we discarded if any unmet)
        };
    }

    logCallback(`Iniciando processamento local. Termos base: ${parsed.map(k=>k.term).join(", ")}`);
    
    const processes = [];
    const seenPids = new Set();
    
    logCallback("Buscando processos na API…");
    const baseTerms = [...new Set(parsed.map(k=>k.term))];
    
    for (const kw of baseTerms) {
        if (isSearchStopped) return;
        let page = 1;
        
        while (true) {
            if (isSearchStopped) return;
            logCallback(`Buscando processos para '${kw}' (pág ${page})`);
            
            try {
                const searchRes = await fetchProxy(PNCP_SEARCH_URL, {
                    q: kw,
                    tipos_documento: "edital",
                    ordenacao: "-data",
                    pagina: page,
                    tam_pagina: 100,
                    status: params.status,
                    ufs: params.uf ? params.uf.toUpperCase() : ""
                });
                
                const items = searchRes.items || [];
                if (items.length === 0) break;
                
                for (const proc of items) {
                    const pid = proc.numero_controle_pncp;
                    if (!pid || seenPids.has(pid)) continue;
                    
                    if (params.date_from) {
                        const pub = (proc.data_publicacao_pncp || "").substring(0,10);
                        if (pub < params.date_from) continue;
                    }
                    if (params.date_to) {
                        const pub = (proc.data_publicacao_pncp || "").substring(0,10);
                        if (pub > params.date_to) continue;
                    }
                    if (params.contratante) {
                        const orgao = (proc.orgao_nome || "").toLowerCase();
                        if (!orgao.includes(params.contratante.toLowerCase())) continue;
                    }
                    
                    seenPids.add(pid);
                    processes.push(proc);
                    
                    if (processes.length >= params.max_processes) break;
                }
                if (processes.length >= params.max_processes) break;
                
                const total = searchRes.total || 0;
                const totalPages = Math.ceil(total / 100);
                if (page >= totalPages) break;
                page++;
                
            } catch (e) {
                logCallback(`⚠ Erro ao buscar processos (API): ${e.message}`);
                break; 
            }
        }
        if (processes.length >= params.max_processes) break;
    }
    
    logCallback(`Encontrados ${processes.length} processos válidos.`);
    if (processes.length === 0) return;
    
    let processedCount = 0;
    
    window.skipProcess = false;
    window.restartProcess = false;
    
    for (const proc of processes) {
        if (isSearchStopped) return;
        processedCount++;
        window.skipProcess = false;
        window.restartProcess = false;
        const pid = proc.numero_controle_pncp;
        const urlMatch = (proc.item_url || "").match(/\/(?:compras|editais)\/(\d+)\/(\d+)\/(\d+)/);
        if (!urlMatch) {
            logCallback(`⚠ URL inválida para ${pid}`);
            continue;
        }
        
        const [_, cnpj, ano, seq] = urlMatch;

        // Update progress bar per process
        if (typeof progressCallback === 'function') {
            progressCallback(processedCount, processes.length, `Verificando ${pid}…`);
        }

        // ── Fetch item count (with robust error handling) ─────────────────────
        let itemsCount = 0;
        try {
            const countStr = await fetchProxy(PNCP_COUNT_URL(cnpj, ano, seq));
            itemsCount = parseInt(countStr, 10) || 0;
        } catch (e) {
            logCallback(`⚠ Não foi possível obter contagem de itens para ${pid}: ${e.message} — processo ignorado.`);
            continue;
        }

        logCallback(`[${processedCount}/${processes.length}] Verificando ${itemsCount} itens do Processo ${pid}`);
        if (itemsCount === 0) continue;

        // Update items_verified counter
        if (typeof _itemsVerified !== 'undefined') {
            _itemsVerified += itemsCount;
            if (typeof _updateStatusPanel === 'function') _updateStatusPanel();
        }
            
        const totalPages = Math.ceil(itemsCount / 500);
        for (let p = 1; p <= totalPages; p++) {
            if (isSearchStopped) return;
            
            if (window.skipProcess) {
                logCallback(`Processo ${pid} pulado pelo usuário.`);
                window.skipProcess = false;
                break; 
            }

            // ── Fetch items page (with robust error handling) ─────────────────
            let localItems;
            try {
                localItems = await fetchProxy(PNCP_ITEMS_URL(cnpj, ano, seq), { pagina: p, tamanhoPagina: 500 });
            } catch (e) {
                logCallback(`⚠ Erro ao buscar itens (pág ${p}) do Processo ${pid}: ${e.message}`);
                break; // skip remaining pages of this process only
            }
            
            for (let i = 0; i < localItems.length; i++) {
                const item = localItems[i];
                const desc = item.descricao || "";
                const normDesc = normalizeStr(desc);
                
                let bestMatch = null;
                let bestQuality = 2; // 0=exact, 1=compound, 2=partial
                
                for (const pk of parsed) {
                    const m = checkMatchStatus(pk, normDesc);
                    if (m) {
                        let isExact = false, isCompound = false;
                        if (pk.groups.length === 0) { isExact = true; }
                        else if (m.groups_unmet === 0) { isExact = true; }
                        else if (m.groups_met > 0) { isCompound = true; }
                        
                        const qScore = isExact ? 0 : (isCompound ? 1 : 2);
                        if (qScore < bestQuality || bestMatch === null) {
                            bestQuality = qScore;
                            bestMatch = { 
                                matched_keywords: `${pk.term}`,
                                match_quality: isExact ? 'exact' : (isCompound ? 'compound' : 'partial')
                            };
                        }
                    }
                }
                
                if (bestMatch) {
                    const rec = {
                        process_id: pid,
                        item_id: item.numeroItem,
                        item_index: ((p - 1) * 500) + i,
                        descricao: desc,
                        quantidade: item.quantidade,
                        unidade: item.unidadeMedida,
                        valor_unitario: item.valorUnitarioEstimado,
                        valor_total: item.valorTotal,
                        data_publicacao: proc.data_publicacao_pncp,
                        contratante: proc.orgao_nome,
                        source_url: `https://pncp.gov.br/app/editais/${cnpj}/${ano}/${seq}`,
                        status: "pending",
                        ...bestMatch
                    };
                    allResults.push(rec);
                    
                    logCallback(`✓ Item #${rec.item_id} → ${desc.substring(0,60)}`);
                    
                    // REACTIVE UI
                    if (typeof showResults === 'function') {
                        showResults();
                    }
                }
            }
        }
    }
    
    logCallback("Extração Local concluída!");
}
