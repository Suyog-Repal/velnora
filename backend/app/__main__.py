from os import getenv

import uvicorn


def _env_flag(name: str, default: bool = False) -> bool:
    value = getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


if __name__ == "__main__":
    app_module = "backend.app.main:app" if __package__ == "backend.app" else "app.main:app"
    uvicorn.run(
        app_module,
        host=getenv("VELNORA_HOST", "0.0.0.0"),
        port=int(getenv("VELNORA_PORT", "8000")),
        reload=_env_flag("VELNORA_RELOAD"),
    )
