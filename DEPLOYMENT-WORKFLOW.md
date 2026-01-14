# Deployment Workflow Guide

## Übersicht

Dieses Projekt nutzt einen **Git-Flow-ähnlichen Workflow** mit zwei Hauptbranches und zwei Railway Environments.

```
Feature Development → develop branch → Development Environment (auto-deploy)
                          ↓ (nach Testing)
                      master branch → Production Environment
```

---

## Branch-Strategie

### Branches

- **`master`**: Production-ready Code
  - Deployed zu Railway Production Environment
  - Nur getesteter, stabiler Code
  - Schütze diesen Branch (optional: GitHub Branch Protection)

- **`develop`**: Development/Staging Code
  - Deployed zu Railway Development Environment
  - Aktive Entwicklung und Testing
  - Auto-deploy bei jedem Push

- **Feature Branches**: `feature/feature-name`
  - Temporäre Branches für neue Features
  - Werden in `develop` gemerged
  - Werden nach Merge gelöscht

- **Bugfix Branches**: `bugfix/bug-description`
  - Für Bug-Fixes
  - Werden in `develop` gemerged

- **Hotfix Branches**: `hotfix/critical-bug`
  - Für kritische Production-Bugs
  - Werden direkt in `master` UND `develop` gemerged

---

## Entwicklungs-Workflow

### 1. Neue Feature entwickeln

```bash
# Stelle sicher, du bist auf develop
git checkout develop
git pull origin develop

# Erstelle Feature Branch
git checkout -b feature/neue-funktion

# Entwickle lokal
# ... code änderungen ...

# Teste lokal
npm run dev

# Committe regelmäßig
git add .
git commit -m "feat: implementiere neue funktion"

# Pushe zu GitHub (optional während Entwicklung)
git push origin feature/neue-funktion
```

### 2. Feature zu Development deployen

```bash
# Merge Feature in develop
git checkout develop
git pull origin develop
git merge feature/neue-funktion

# Pushe zu GitHub
git push origin develop

# ✓ Railway deployed automatisch zu Development Environment!
```

### 3. Testing auf Development

1. Warte auf Railway Deployment (ca. 2-5 Minuten)
2. Checke Deployment Status im Railway Dashboard
3. Teste die App auf der Development URL
4. Checke Logs bei Problemen: `railway logs` oder im Dashboard

**Testing Checklist:**
- [ ] App startet erfolgreich
- [ ] Keine Console Errors
- [ ] Shopify OAuth funktioniert
- [ ] Neue Features funktionieren wie erwartet
- [ ] Existierende Features funktionieren noch
- [ ] Database Migrations liefen erfolgreich

### 4. Release zu Production

Nur wenn **alle Tests** auf Development erfolgreich waren:

```bash
# Wechsle zu master
git checkout master
git pull origin master

# Merge develop in master
git merge develop

# Optional: Tag für Version
git tag -a v1.2.0 -m "Release version 1.2.0"

# Pushe zu GitHub
git push origin master
git push origin --tags

# Railway deployed zu Production (manuell oder auto)
```

### 5. Cleanup Feature Branch

```bash
# Lösche lokalen Branch
git branch -d feature/neue-funktion

# Lösche remote Branch
git push origin --delete feature/neue-funktion
```

---

## Hotfix-Workflow (Kritische Production Bugs)

```bash
# Erstelle Hotfix von master
git checkout master
git checkout -b hotfix/kritischer-bug

# Fixe den Bug
# ... fix code ...

# Teste lokal
npm run dev

# Committe
git add .
git commit -m "fix: kritischer bug behoben"

# Merge in master
git checkout master
git merge hotfix/kritischer-bug
git push origin master

# WICHTIG: Merge auch in develop!
git checkout develop
git merge hotfix/kritischer-bug
git push origin develop

# Cleanup
git branch -d hotfix/kritischer-bug
```

---

## Rollback-Strategie

### Bei Problemen in Production:

#### Option 1: Railway Dashboard Rollback
1. Öffne Railway Dashboard
2. Wähle "production" Environment
3. Klicke auf Service → "Deployments"
4. Finde die letzte funktionierende Deployment
5. Klicke "..." → "Redeploy"

#### Option 2: Git Revert
```bash
git checkout master

# Finde den problematischen Commit
git log --oneline

# Revert (erstellt neuen Commit der den alten rückgängig macht)
git revert <commit-hash>

# Pushe
git push origin master

# Merge auch in develop
git checkout develop
git merge master
git push origin develop
```

#### Option 3: Hard Reset (Vorsicht!)
```bash
# NUR in Notfällen!
git checkout master
git reset --hard <letzter-guter-commit>
git push origin master --force

# Update develop
git checkout develop
git merge master
```

---

## Database Migrations

### Development:
```bash
# Migrations laufen automatisch beim Railway Deployment
# Oder manuell via Railway CLI:
railway environment development
railway run npx prisma migrate deploy
```

### Production:
```bash
# IMMER zuerst auf Development testen!
# Dann in Production:
railway environment production
railway run npx prisma migrate deploy
```

**Wichtig**: Teste Migrations IMMER zuerst auf Development mit echten Daten!

---

## Environment Variables aktualisieren

### Development:
1. Railway Dashboard → "development" Environment
2. Service → "Variables"
3. Füge/Update Variable
4. Klicke "Redeploy" wenn nötig

### Production:
1. Railway Dashboard → "production" Environment
2. Service → "Variables"
3. Füge/Update Variable
4. **VORSICHT**: Checke ob Redeploy nötig ist

---

## Commit Message Convention

Nutze **Conventional Commits** für bessere Historie:

```
feat: Neue Feature
fix: Bug-Fix
docs: Dokumentation
style: Formatierung (keine Code-Änderung)
refactor: Code Refactoring
test: Tests hinzufügen
chore: Build-Prozess, Dependencies

Beispiele:
feat: add product bulk translation
fix: resolve authentication timeout issue
docs: update Railway setup guide
refactor: simplify AI provider selection
```

---

## Best Practices

### DO ✓
- Immer auf `develop` entwickeln und testen
- Regelmäßig committen mit aussagekräftigen Messages
- Features in separate Branches entwickeln
- Auf Development testen BEVOR Production Deploy
- Database Backups vor großen Migrations
- Logs checken nach jedem Deployment
- Environment Variables dokumentieren

### DON'T ✗
- Niemals direkt auf `master` pushen ohne Testing
- Keine ungetesteten Features in Production
- Keine Secrets im Code committen
- Keine `git push --force` auf `master` (außer Notfall)
- Keine Production Database Migrations ohne Testing
- Keine experimentellen Änderungen direkt in Production

---

## Troubleshooting

### Development Deployment schlägt fehl:
1. Checke Railway Logs: `railway logs` oder Dashboard
2. Prüfe alle Environment Variables sind gesetzt
3. Prüfe ob Build-Command korrekt ist
4. Teste Build lokal: `npm run build`

### Production Deployment schlägt fehl:
1. **NICHT PANIK!** Railway behält die alte Version am Laufen
2. Checke Logs
3. Rollback zur vorherigen Version (siehe oben)
4. Fixe Problem auf `develop` und teste
5. Dann erst wieder Production Deploy

### Merge Konflikte:
```bash
# Bei Konflikten zwischen develop und master
git checkout develop
git pull origin develop
git checkout master
git pull origin master
git merge develop

# Konflikte manuell lösen
# Öffne konfliktierte Dateien und löse
git add .
git commit -m "merge: resolve conflicts"
git push origin master
```

---

## Monitoring

### Nach jedem Production Deploy:
1. ✓ Checke App ist erreichbar
2. ✓ Checke Login funktioniert
3. ✓ Checke kritische Features funktionieren
4. ✓ Checke Logs für Errors
5. ✓ Checke Database Connections
6. ✓ Warte 5-10 Minuten und checke nochmal

### Tools:
- Railway Dashboard Logs
- Railway Metrics (CPU, Memory, etc.)
- Shopify Partner Dashboard (für App-Installationen)
- Optional: Sentry für Error Tracking

---

## Quick Reference

```bash
# Daily Development
git checkout develop
git pull
# ... make changes ...
git add . && git commit -m "feat: ..."
git push

# Release to Production
git checkout master
git merge develop
git push

# Check Railway Status
railway environment development
railway status
railway logs

# Check which environment you're on
railway environment

# Switch environment
railway environment production
```

---

## Hilfe & Support

- **Railway Docs**: https://docs.railway.app/
- **Git Flow Guide**: https://nvie.com/posts/a-successful-git-branching-model/
- **Conventional Commits**: https://www.conventionalcommits.org/

Bei Fragen checke:
1. Railway Logs
2. Dieses Dokument
3. [RAILWAY-SETUP.md](./RAILWAY-SETUP.md)
4. Railway Discord/Support
