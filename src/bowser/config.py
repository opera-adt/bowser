# import secrets
from typing import Union

from pydantic import AnyHttpUrl, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Settings for FastAPI app.

    All fields can be overridden by a matching environment variable. The CLI
    writes these at startup so uvicorn workers see the same config after the
    import-boundary crossing; runtime code should always go through
    ``settings.<field>`` rather than calling ``os.getenv`` directly.
    """

    # --- data source (one-time-at-startup) ---
    BOWSER_DATASET_CONFIG_FILE: str = "bowser_rasters.json"
    BOWSER_STACK_DATA_FILE: str = ""
    # Multi-dataset catalog file (TOML). When set, bowser can run without a
    # single default dataset — every request must carry ``?dataset=<id>``.
    # Schema + registry live in this PR layer; the catalog-only branch of
    # ``BowserState.load`` was introduced in the previous layer.
    BOWSER_CATALOG_FILE: str = ""

    # --- UI ---
    BOWSER_TITLE: str = ""
    LOG_LEVEL: str = "WARNING"

    # --- auth ---
    # Path to an htpasswd-format file for HTTP Basic Auth (empty = no auth)
    BOWSER_HTPASSWD_FILE: str = ""

    # Let the page open any GeoZarr path or URL the server can read
    # (POST /catalog/open).
    # Off unless set: `bowser run` turns it on only for a local single-worker server.
    BOWSER_ALLOW_OPEN: bool = False
    # Keep cubes opened from the page in BOWSER_CATALOG_FILE, so they are listed
    # next time (the desktop app).
    BOWSER_REMEMBER_OPENED: bool = False

    # Show the OPERA emblem at the top of the side panel instead of the Bowser mark
    # (`bowser run --opera-logo`).
    BOWSER_OPERA_LOGO: bool = False

    # --- Assistant tab (src/bowser/assistant) ---
    # A chat on the page that answers with the user's own AI provider and
    # Bowser's tools. Off unless set: `bowser run` and `bowser lite` turn it on
    # only for a local single-worker server, like BOWSER_ALLOW_OPEN.
    BOWSER_ASSISTANT: bool = False
    # Let the page save API keys on this server (system keychain or a private
    # file), from this computer only.
    # Only for a server on the user's own computer: on a shared server every
    # visitor would spend and could replace the key. A hosted server leaves this
    # off and gives its key below.
    BOWSER_ASSISTANT_PAGE_KEYS: bool = False
    # Where saved keys and provider settings go (empty: the user's config dir).
    BOWSER_ASSISTANT_KEY_FILE: str = ""
    # Tool calls the Assistant may make for one question (data and page tools).
    BOWSER_ASSISTANT_TOOL_BUDGET: int = 8
    # Seconds a signed-in agent's request to run a tool waits for an answer.
    BOWSER_ASSISTANT_PERMISSION_SECONDS: float = 600.0
    # Geocoder (place names to coordinates): a Nominatim-compatible search URL,
    # or "off". Empty: OpenStreetMap's Nominatim (one request per second).
    BOWSER_GEOCODER_URL: str = ""
    # The server's own provider (hosted): anthropic, openai, gemini, openrouter
    # or ollama, its key, and optionally the model.
    BOWSER_AI_PROVIDER: str = ""
    BOWSER_AI_KEY: SecretStr = SecretStr("")
    BOWSER_AI_MODEL: str = ""
    # Each provider's usual variable, used when set.
    ANTHROPIC_API_KEY: SecretStr = SecretStr("")
    OPENAI_API_KEY: SecretStr = SecretStr("")
    GEMINI_API_KEY: SecretStr = SecretStr("")
    OPENROUTER_API_KEY: SecretStr = SecretStr("")

    # --- runtime behaviour flags (previously read via os.getenv "YES"/"NO") ---
    BOWSER_USE_SPATIAL_REFERENCE_DISP: bool = True

    # SECRET_KEY: str = secrets.token_urlsafe(32)
    # SERVER_NAME: str
    # SERVER_HOST: AnyHttpUrl
    # BACKEND_CORS_ORIGINS is a JSON-formatted list of origins
    # e.g: '["http://localhost", "http://localhost:4200", "http://localhost:3000", \
    # "http://localhost:8080", "http://local.dockertoolbox.tiangolo.com"]'
    BACKEND_CORS_ORIGINS: list[AnyHttpUrl] = []
    DOMAIN: str = "localhost"

    @classmethod
    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    def _assemble_cors_origins(cls, v: Union[str, list[str]]) -> Union[list[str], str]:
        if isinstance(v, str) and not v.startswith("["):
            return [i.strip() for i in v.split(",")]
        elif isinstance(v, (str, list)):
            return v
        raise ValueError(v)

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()
