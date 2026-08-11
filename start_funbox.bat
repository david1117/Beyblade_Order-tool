@echo off
title beyblade_moniter
cd /d "%~dp0"

echo ============================================
echo   beyblade_moniter  (Funbox / eslite / momo)
echo ============================================
echo.

rem ---------- 1. required files ----------
set "MISSING="
if not exist "server.py"      set "MISSING=%MISSING% server.py"
if not exist "monitor.py"     set "MISSING=%MISSING% monitor.py"
if not exist "dashboard.html" set "MISSING=%MISSING% dashboard.html"
if defined MISSING goto NOFILES

rem settings live in the config folder (one file per shop)
if not exist "config\funbox.json" (
  if exist "config.sample" (
    echo config folder not found - creating it from config.sample ...
    xcopy /e /i /y "config.sample" "config" >nul
    echo Created config folder. Edit config\funbox.json etc. to add cookies / targets.
    echo.
  ) else (
    if not exist "config.json" (
      echo [ERROR] No config folder, no config.sample, no config.json.
      goto END
    )
  )
)

rem ---------- 2. find a Python that ACTUALLY runs (skip MS Store stub) ----------
set "PY=py -3"
%PY% -c "import sys" >nul 2>&1 && goto HAVEPY
set "PY=python"
%PY% -c "import sys" >nul 2>&1 && goto HAVEPY
set "PY=python3"
%PY% -c "import sys" >nul 2>&1 && goto HAVEPY
goto NOPY

:HAVEPY
for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])"') do set "PYVER=%%v"
echo Using Python %PYVER%  ^(%PY%^)
echo.

rem ---------- 3. dependencies ----------
echo Checking packages...
%PY% -c "import requests, bs4" >nul 2>&1
if errorlevel 1 (
  echo   installing requests + beautifulsoup4 ...
  %PY% -m pip install --quiet --disable-pip-version-check requests beautifulsoup4
  if errorlevel 1 %PY% -m pip install requests beautifulsoup4
)

rem curl_cffi: impersonates a real browser TLS fingerprint.
rem Without it eslite/momo answer 429 (bot-block) and everything shows out-of-stock.
%PY% -c "import curl_cffi" >nul 2>&1
if errorlevel 1 (
  echo   installing curl_cffi ^(needed to bypass eslite/momo bot-block^) ...
  %PY% -m pip install --quiet --disable-pip-version-check curl_cffi
  if errorlevel 1 %PY% -m pip install curl_cffi
)

rem ---------- 4. report what we got ----------
%PY% -c "import requests, bs4" >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] requests/beautifulsoup4 install failed - check your internet/proxy.
  goto END
)
echo   requests + beautifulsoup4 OK
%PY% -c "import curl_cffi" >nul 2>&1
if errorlevel 1 (
  echo   [WARN] curl_cffi NOT installed - eslite/momo may show 429 / always out-of-stock.
  echo          Fix later with:  %PY% -m pip install curl_cffi
) else (
  echo   curl_cffi OK  ^(eslite/momo bot-block bypass active^)
)

echo.
echo Reminder: install the Tampermonkey scripts in the browser you shop with
echo   eslite_grab.user.js  (eslite auto add-to-cart)
echo   momo_grab.user.js    (momo timed grab)
echo and stay logged in to funbox / eslite / momo.
echo.
echo Starting server... your browser will open the dashboard.
echo Close this window to stop monitoring.
echo.
%PY% server.py
goto END

:NOFILES
echo [ERROR] Missing required file(s):%MISSING%
echo Unzip the whole package into one folder and run this .bat from inside it.
goto END

:NOPY
echo [ERROR] No working Python found.
echo.
echo Install Python from https://www.python.org/downloads/
echo IMPORTANT: tick "Add Python to PATH" during install, then run this file again.

:END
echo.
pause
