# 🏛️ PNCP Bot

Ferramenta para extração automatizada de itens de processos do **Portal Nacional de Contratações Públicas** (PNCP).

## Instalação

```bash
cd "d:\Dev\PNCP BOT"
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Interface Web (recomendado)

```bash
py webapp.py
# Abra http://localhost:5000
```

A interface inclui:
- 🔍 Formulário de busca com keywords, UF, datas, contratante e fuzzy
- 📊 Progresso em tempo real com log ao vivo
- 📋 Cards de resultado com tags de qualidade (✓ exato / ~ parcial)
- ✓/✗ Aprovar / rejeitar itens e exportar aprovados

## CLI (para scripts)

```bash
# Busca simples
py cli.py -k "cabo" --uf BA --max-processes 10

# Múltiplos termos com qualificadores
py cli.py -k "cabo [vermelho], tomada [20a]" --uf BA

# Com filtros de data
py cli.py -k "cabo" --uf BA --date-from 2026-01-01 -o ./output
```

### Opções CLI

| Opção | Descrição | Padrão |
|---|---|---|
| `-k` / `--keywords` | Palavras-chave (vírgula). Qualificadores entre `[colchetes]` | — |
| `--uf` | Sigla do estado (BA, SP, RJ…) | Todos |
| `--date-from` | Data inicial (YYYY-MM-DD) | — |
| `--date-to` | Data final (YYYY-MM-DD) | — |
| `--contratante` | Filtro por nome do contratante | — |
| `--max-processes` | Máximo de processos | 100 |
| `--fuzzy-threshold` | Limiar fuzzy 0–100 | 80 |
| `--rate-limit` | Segundos entre requisições | 1.0 |
| `-o` / `--output-dir` | Diretório de saída | `./output` |
| `-v` / `--verbose` | Debug logging | — |

## Saída

```
output/
├── results.json
├── results.csv
└── pncp_bot.log
```

## Qualificadores

Qualificadores entre `[colchetes]` são **opcionais** — itens fazem match pelo termo base. Qualificadores servem para destacar resultados mais relevantes:

- `cabo [vermelho]` → encontra **todos** os cabos, marca como ✓ exato os vermelhos
- `cabo [vermelho], tomada [20a]` → busca cabos **e** tomadas (lógica OR)

## Testes

```bash
# Unit tests (offline)
py -m pytest tests/ -v -m "not integration"

# Integration tests (requer internet)
py -m pytest tests/test_integration.py -v -s
```

## Arquitetura

| Módulo | Responsabilidade |
|---|---|
| `config.py` | URLs, constantes, configurações |
| `fetcher.py` | Cliente HTTP com retry/rate-limit/CAPTCHA |
| `parser.py` | Normalização, parsing de keywords, matching |
| `exporter.py` | Export JSON/CSV |
| `pipeline.py` | Lógica de extração compartilhada (CLI + web) |
| `cli.py` | Interface de linha de comando |
| `webapp.py` | Interface web Flask |
| `web/` | Templates HTML, CSS, JS |
