@echo off
cd /d "%~dp0"
if not exist venv (
    echo Creando entorno virtual...
    python -m venv venv
    call venv\Scripts\pip install -r requirements.txt
)
call venv\Scripts\pip install -r requirements.txt --quiet
start "" http://127.0.0.1:8000
venv\Scripts\python -m uvicorn server.main:app --host 127.0.0.1 --port 8000
pause
