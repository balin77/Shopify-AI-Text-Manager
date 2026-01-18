@echo off
echo Regenerating package-lock.json using Node 22 in Docker...
echo.

REM Remove old lock file
if exist package-lock.json del package-lock.json

REM Use Docker with Node 22 to generate new lock file
docker run --rm -v "%CD%:/app" -w /app node:22-alpine sh -c "rm -f package-lock.json && npm install --package-lock-only"

echo.
echo Lock file regenerated successfully!
echo.
echo Now commit and push the changes:
echo git add package-lock.json
echo git commit -m "fix: Regenerate package-lock.json using Node 22 for Docker compatibility"
echo git push
echo.
pause
