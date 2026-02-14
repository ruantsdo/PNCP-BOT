"""
PNCP Bot — Configuration & constants.
"""

# ── API Base URLs ────────────────────────────────────────────────────────────
SEARCH_URL = "https://pncp.gov.br/api/search/"
ITEMS_URL = (
    "https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens"
)
ITEMS_COUNT_URL = (
    "https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens/quantidade"
)
PROCESS_DETAIL_URL = (
    "https://pncp.gov.br/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}"
)
PORTAL_PROCESS_URL = "https://pncp.gov.br/app/editais/{cnpj}/{ano}/{seq}"

# ── Defaults ─────────────────────────────────────────────────────────────────
DEFAULT_SEARCH_PAGE_SIZE = 50
DEFAULT_MAX_PROCESSES = 100
DEFAULT_FUZZY_THRESHOLD = 80
DEFAULT_OUTPUT_DIR = "./output"

# ── Rate Limiting & Retry ────────────────────────────────────────────────────
RATE_LIMIT_DELAY = 1.0           # seconds between requests
MAX_RETRIES = 3
RETRY_BACKOFF_FACTOR = 2.0       # exponential: 2s, 4s, 8s
RETRY_STATUS_CODES = [429, 500, 502, 503, 504]

# ── HTTP ─────────────────────────────────────────────────────────────────────
REQUEST_TIMEOUT = 30             # seconds
USER_AGENT = (
    "PNCP-Bot/1.0 (Automated public procurement data extraction; "
    "contact: pncpbot@example.com)"
)

# ── UF Codes ─────────────────────────────────────────────────────────────────
UF_CODES = {
    "AC": "Acre", "AL": "Alagoas", "AP": "Amapá", "AM": "Amazonas",
    "BA": "Bahia", "CE": "Ceará", "DF": "Distrito Federal",
    "ES": "Espírito Santo", "GO": "Goiás", "MA": "Maranhão",
    "MT": "Mato Grosso", "MS": "Mato Grosso do Sul",
    "MG": "Minas Gerais", "PA": "Pará", "PB": "Paraíba",
    "PR": "Paraná", "PE": "Pernambuco", "PI": "Piauí",
    "RJ": "Rio de Janeiro", "RN": "Rio Grande do Norte",
    "RS": "Rio Grande do Sul", "RO": "Rondônia", "RR": "Roraima",
    "SC": "Santa Catarina", "SP": "São Paulo", "SE": "Sergipe",
    "TO": "Tocantins",
}
