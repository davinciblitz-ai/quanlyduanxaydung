@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Can cai Node.js 22.13 tro len de chay may chu.
  echo Ban van co the mo index.html de thu che do ca nhan.
  pause
  exit /b 1
)
echo Mo trinh duyet tai http://127.0.0.1:4173/
echo Giu cua so nay khi su dung web. Bam Ctrl+C de dung.
node server.cjs
pause
