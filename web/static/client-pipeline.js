// ── Native Fuzzy Match ──────────────────────────────────────────
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

// ── Normalization & Parsing ──────────────────────────────────────
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
            const regexInner = /\{([^\}]+)\}|([^|{}]+)/g;
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

// ── Fetch Helper ────────────────────────────────────────────────
async function fetchProxy(url, params = {}) {
    const searchParams = new URLSearchParams();
    searchParams.append("url", url);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") {
            searchParams.append(k, v);
        }
    }
    const proxyUrl = `/api/proxy?${searchParams.toString()}`;
    const resp = await fetch(proxyUrl);
    if (!resp.ok) {
        throw new Error(`Erro na API (${resp.status}) ao acessar ${url}`);
    }
    return resp.json();
}

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
                const searchRes = await fetchProxy("https://pncp.gov.br/api/search/", {
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
                logCallback(`Erro ao buscar processos (API): ${e.message}`);
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
            logCallback(`URL inválida para ${pid}`);
            continue;
        }
        
        const [_, cnpj, ano, seq] = urlMatch;
        try {
            const cntUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens/quantidade`;
            const countStr = await fetchProxy(cntUrl);
            const itemsCount = parseInt(countStr, 10) || 0;
            
            logCallback(`[${processedCount}/${processes.length}] Verificando ${itemsCount} itens do Processo ${pid}`);
            if (itemsCount === 0) continue;
            
            const totalPages = Math.ceil(itemsCount / 500);
            for (let p = 1; p <= totalPages; p++) {
                if (isSearchStopped) return;
                
                if (window.skipProcess) {
                    logCallback(`Processo ${pid} pulado pelo usuário.`);
                    window.skipProcess = false;
                    break; 
                }
                // restartProcess removed (instabile)
                
                const itemsUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens`;
                const localItems = await fetchProxy(itemsUrl, { pagina: p, tamanhoPagina: 500 });
                
                // Count ALL scanned items (matched or not)
                if (typeof _itemsVerified !== 'undefined') {
                    _itemsVerified += localItems.length;
                    if (typeof _updateStatusPanel === 'function') _updateStatusPanel();
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
                                    matched_keywords: `${pk.term}`, // Cleaned as requested
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
        } catch (e) {
            logCallback(`Erro ao buscar itens do Processo ${pid}: ${e.message}`);
        }
    }
    
    logCallback("Extração Local concluída!");
}
