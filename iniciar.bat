@echo off
cd /d "%~dp0"
if not exist venv (
    echo Creando entorno virtual...
    python -m venv venv
    call venv\Scripts\pip install -r requirements.txt
)
call venv\Scripts\pip install -r requirements.txt --quiet
echo.
echo Accesible en esta PC:  http://127.0.0.1:8000
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo Accesible en tu red local en: http://%%a:8000 ^(quita el espacio inicial^)
echo.
start "" http://127.0.0.1:8000
venv\Scripts\python -m uvicorn server.main:app --host 0.0.0.0 --port 8000
pause
