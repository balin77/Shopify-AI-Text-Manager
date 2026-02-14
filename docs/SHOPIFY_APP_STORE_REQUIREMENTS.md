# Shopify App Store Anforderungen

Alle Anforderungen, die Shopify an Apps im App Store stellt.

---

## 1. Allgemeine Funktionalitat

- Alle Apps im Shopify App Store mussen uber eine Benutzeroberflache funktionieren, unabhangig davon, wie die App gestartet wird.
- Betriebsfehler (Fehler innerhalb der Funktionalitat einer App) sind akzeptabel, Webfehler (404, 500, 300) sind **nicht** akzeptabel.
- Deine App muss frei von Benutzeroberflachenfehlern, Anzeigeproblemen oder Fehlerseiten sein, die den Abschluss der Uberprufung **vollstandig** verhindern.
- Deine App muss frei von Fehlern in der Benutzeroberflache, Anzeigeproblemen oder Fehlerseiten sein, die den Abschluss der Bewertung **teilweise** verhindern.

## 2. Authentifizierung & OAuth

- Deine App muss sich sofort mit OAuth authentifizieren, bevor andere Schritte erfolgen. Handler sollten nicht in der Lage sein, mit der Benutzeroberflache (UI) vor OAuth zu interagieren.
- Deine App muss Handler nach der Installation zur Benutzeroberflache (UI) weiterleiten, nachdem sie den Zugriff auf Berechtigungen auf der OAuth-Handshake-Seite akzeptiert haben.
- Hilf Handlern, problemlos zu den Workflows in deiner App zuruckzugeben, wenn sie diese neu installieren mochten. Deine App muss sich sofort mit OAuth authentifizieren, bevor weitere Schritte erfolgen, auch wenn der Handler deine App zuvor installiert und dann wieder deinstalliert hat.

## 3. Installation & Konfiguration

- Apps durfen ausschliesslich auf Shopify-Dienste installiert und initiiert werden. Deine App darf wahrend der Installation oder des Konfigurationsablaufs nicht die manuelle Eingabe einer myshopify.com-URL oder der Domain eines Shops anfordern.
- Wenn deine App Login-Anmeldedaten erfordert, mussen die von dir zur Uberprufung bereitgestellten Zugangsdaten gultig sein und vollen Zugriff auf das vollstandige Funktionsset der App gewahren. Uberprufe alle Anmeldedaten vor der Einreichung, um Probleme bei der Uberprufung zu vermeiden.
- Fuge Kontoanmeldedaten in deine Testanweisungen ein, damit wir deine App uberprufen konnen. Stelle sicher, dass diese Kontoanmeldedaten aktuell bleiben.
- Deine Anwendung darf keine Desktop-Anwendung benotigen, um zu funktionieren.

## 4. Eingebettetes Erlebnis & App Bridge

- Deine App muss ein konsistentes eingebettetes Erlebnis bieten, indem sie sicherstellt, dass alle Funktionen ausserhalb der Plattform direkt in den Shopify-Adminbereich integriert sind.
- Ab dem 13. Marz 2024 mussen alle Apps die neueste Version der Shopify App Bridge verwenden, indem sie das Script-Tag `app-bridge.js` vor allen anderen Script-Tags hinzufugen. Es wird empfohlen, es zum Anfang jedes Dokuments deiner App oder als erstes Script-Element hinzuzufugen.
- Das Max-Modal (fruher bekannt als Vollbildmodus) darf nicht ohne Handlerinteraktion gestartet werden. Das Max-Modal kann nicht uber das Navigationsmenu der App gestartet werden.
- Deine eingebettete App muss ordnungsgemas funktionieren, ohne auf Drittanbieter-Cookies oder lokalen Speicher angewiesen zu sein, auch wenn sie im Inkognito-Modus in Chrome aufgerufen wird.

## 5. Sicherheit & Datenschutz

- Alle Daten, die zwischen einem Client (z. B. dem Webbrowser eines Handlers) und deinem App-Server ausgetauscht werden, sollten mit Transport Layer Security (TLS) verschlusselt werden, um sicherzustellen, dass alle ubertragenen Daten nur von deinem Applikationsserver gelesen werden konnen. Deine App muss ein gultiges TLS/SSL-Zertifikat ohne Fehler haben.
- Shopify kann die Sicherheit einer Bestellung nicht garantieren, die uber einen externen oder Drittanbieter-Checkout aufgegeben wurde. Apps, die den Checkout oder die Zahlungsabwicklung umgehen oder Transaktionen uber die Shopify API im Zusammenhang mit solchen Aktivitaten registrieren, sind verboten.

## 6. API-Bereiche (Scopes)

- Nur die fur die Funktion der App erforderlichen API-Bereiche sind zulassig.
- Wenn deine App die Bereiche `write_customer_payment_methods` oder `write_own_subscription_contracts` anfordert, musst du moglicherweise nachweisen, dass sie wirklich notwendig fur die Funktion deiner App sind.
- Wenn deine App auf den Bereich `read_all_orders` zugreift, muss sie die Notwendigkeit fur diesen Bereich nachweisen.
- Wenn deine App auf den Bereich `read_checkout_extensions_chat` zugreift, musst du die Notwendigkeit fur diesen Bereich nachweisen.
- Wenn deine App auf den Bereich `write_payment_mandate` zugreift, musst du die Notwendigkeit fur diesen Bereich nachweisen.
- Wenn deine App auf den Bereich `write_checkout_extensions_apis` zugreift, musst du die Notwendigkeit fur diesen Bereich nachweisen.
- Deine App muss fur die Verwendung von Shopify-APIs konfiguriert sein, um Handler bestmoglich zu unterstutzen. Apps, die keine Shopify-APIs verwenden oder benotigen, sind nicht zulassig.

## 7. Abrechnung & Preise

- Wenn du fur deine App Gebuhren erhebst, muss sie Managed Pricing oder die Shopify Billing API korrekt implementieren, um sicherzustellen, dass du uber sie Gebuhren annehmen, ablehnen und bei einer Neuinstallation erneut um Genehmigung der Gebuhren bitten kannst.
- Deine App muss Handlern ermoglichen, ihren Preisplan zu aktualisieren oder herabzustufen, ohne dein Support-Team kontaktieren oder die App neu installieren zu mussen. Dies umfasst die Sicherstellung, dass die Gebuhren erfolgreich auf der Seite mit dem Verlauf der Anwendungsgebuhren im Handler-Adminbereich verarbeitet werden.

## 8. Checkout & Zahlungen

- Apps durfen keine optionalen Gebuhren automatisch zum Warenkorb eines Kaufers hinzufugen oder vorauswahlen, die den Gesamtpreis an der Kasse erhohen. Apps durfen optionale Gebuhren nur zum Warenkorb oder an der Kasse hinzufugen, nachdem die zusatzlichen Kosten auf eine fur den Kaufer klare Weise angezeigt wurden und die ausdruckliche Zustimmung des Kaufers eingeholt wurde.
- Deine App darf keine Methoden zur Bearbeitung von Ruckerstattungen ausserhalb des ursprunglichen Zahlungsabwicklers anbieten.
- Payment Gateway-Apps mussen durch ein Antragsverfahren autorisiert werden. Sie mussen mit der Payments API erstellt werden.

## 9. Versand

- Apps durfen Versandoptionen nicht auf eine Weise andern oder neu anordnen, die den Standardversandpreis erhoht. Die gunstigste Versandoption muss immer standardmasig ausgewahlt sein. Diese Einschrankung gilt nicht fur Nicht-Versand-Liefermethoden wie Abholung im Geschaft, lokale Lieferung und Abholstandorte.

## 10. Datensynchronisation

- Wenn deine App Daten mit Shopify synchronisiert, musst du dafur sorgen, dass die Daten zwischen beiden Plattformen genau und korrekt transferiert werden. Auf diese Weise wird sichergestellt, dass alle synchronisierten Daten im Shopify-Adminbereich, in deiner App und in allen zusatzlichen Plattformen, von denen deine App abhangt, konsistent sind.

## 11. Produktdaten & geistiges Eigentum

- In deiner App durfen nur Produktinformationen vervielfaltigt werden, zu deren Verwendung der Handler offiziell berechtigt ist: seine eigenen Produkte, offiziell lizenzierte oder per Dropshipping bereitgestellte Produkte. Marketing-Aussagen wie "Import aus jedem Shop weltweit" oder "Kopieren der Produktinformationen von jeder beliebigen Website" sind nicht zulassig, unabhangig davon ob deine App oder eine Chrome-Erweiterung verwendet wird.
- Deine App und dein App-Angebot sollten nur sachliche Informationen enthalten. Apps, die Daten falschen, um Handler oder Kaufer:innen zu tauschen, wie gefalschte Bewertungen oder falsche Kaufbenachrichtigungen, verstossen gegen die Partnerprogramm-Vereinbarung und die Nutzungsbedingungen.

## 12. Verbotene App-Typen

- Apps, die es Handlern ermoglichen, ihre Geschafte in Kleinanzeigen-ahnliche Marktplatze zu verwandeln, konnen nicht uber den Shopify App Store vertrieben werden.
- Apps, die Handler mit Agenturen und Freelancer:innen verbinden, konnen nicht uber den Shopify App Store vertrieben werden.
- Apps, die Kapitalfinanzierung bereitstellen (einschliesslich, aber nicht beschrankt auf Darlehen, Bargeldvorschusse und Kauf von Forderungen), konnen nicht uber den Shopify App Store vertrieben werden.
- Shopify akzeptiert derzeit keine Apps, die eine Verbindung zu einem POS-System ausserhalb von Shopify herstellen.
- App darf nicht identisch mit anderen Apps sein, die du im Shopify App Store veroffentlicht hast.

## 13. Vertriebskanal-Konfiguration

- Falls deine App die Shopify-Definition eines Vertriebskanals nicht erfullt: Erstelle deine App neu, ohne eine Konfiguration der Vertriebskanale zu aktivieren, und reiche sie dann zur Uberprufung ein. Das Umwandeln einer App in einen Vertriebskanal ist ein Prozess, der nicht ruckgangig gemacht werden kann.

## 14. Themes

- Deine App darf Handlern kein Herunterladen von Themes ermoglichen. Themes durfen nur uber den Shopify Theme Store installiert werden.

## 15. Browser-Erweiterungen

- Browser-Erweiterungen sind nur als optionale Funktion erlaubt.

## 16. Admin-UI-Erweiterungen

- Admin-UI-Blocke, Admin-Tatigkeiten und Admin-Links mussen im Hinblick auf den Funktionsumfang vollstandig sein und neue Funktionen oder Inhalte bieten.
- Du darfst Admin-UI-Blocke, Admin-Tatigkeiten oder Admin-Links nicht verwenden, um fur deine App zu werben, verwandte Apps zu bewerben oder um Bewertungen zu bitten.

## 17. App-Listing / Angebot

### App-Name & Symbol
- Der App-Name im Developer Dashboard (bearbeitet uber TOML-Datei oder bei Veroffentlichung einer neuen Version) und im App-Einreichungsformular (das das App Store-Angebot steuert) muss ubereinstimmen oder ahnlich sein. "Ahnlich" bedeutet, dass alle Namensvariationen gemeinsame Worter enthalten.
- Bearbeite dein App-Symbol so, dass es in deinem Dev Dashboard und deinem App-Listing identisch ist. Andere das Symbol im Bereich App-Einstellungen deines Dev Dashboard.

### Untertitel
- Der App-Karten-Untertitel hilft Handlern, schnell zu verstehen, was deine App tut und was sie von anderen unterscheidet. Fasse deine App in einem pragnanten Satz zusammen und erklare den Wert deiner App. Fuge keine Schlusselworter zu deinem Untertitel hinzu, um die Suchleistung zu verbessern. Verwende keine personlichen Handlerinformationen ohne Zustimmung des Handlers. Fuge keine Daten oder Statistiken hinzu.

### App-Details
- Deine App-Details mussen eine klare Erklarung der Funktionalitat deiner App mit ausreichenden Informationen uber Funktionen enthalten, damit Handler sie bedenkenlos installieren konnen. Vermeide ubermassige Verwendung von Marketing-Schlusselwortern oder nur eine strukturierte Funktionsliste.

### Preisinformationen
- Stelle sicher, dass deine Preisinformationen alle Preisoptionen wie kostenlose Testzeit und Gebuhrendetails enthalten.
- Handler scannen bestimmte Stellen in App-Listings, um Kosten und Wert schnell zu verstehen. Stelle die Preisinformationen nicht in nicht dafur vorgesehene Bereiche wie dein App-Logo, um Verwirrung bei den Handlern zu vermeiden. Bewahre diese Informationen in den Preisdetails auf.

### Screencast / Demo-Video
- Fuge einen Screencast hinzu, um das Onboarding und die Funktionen deiner App wie im Angebot beschrieben zu demonstrieren. Stelle sicher, dass das Video klare Schritt-fur-Schritt-Anweisungen bietet, die zeigen, wie die Kernfunktionen deiner App eingerichtet werden. Der Screencast sollte auf Englisch sein oder englische Untertitel haben.

### Tags & Kategorien
- Deine Tags sollten die primaren Funktionen deiner App genau widerspiegeln. Uberprufe die Definitionen der Kategorien und Tags, damit Handler deine App finden konnen.

### Sprachen
- Der Bereich "Sprachen" deines App-Angebots darf nur Sprachen auflisten, in denen Handler die UI deiner App verwenden konnen. Wenn deine App mehrere Sprachen fur kundenseitige Funktionen anbietet, kannst du diese in den Bereichen "App-Details" oder "Mediengalerie" deines App-Listings beschreiben (optional).

### Geografische Anforderungen
- Gib geografische Anforderungen oder spezifische API-Berechtigungen im Angebot deiner App an, wenn diese fur die Funktion deiner App erforderlich sind. Nur Handler am richtigen geografischen Standort oder mit einem Plan mit den erforderlichen API-Berechtigungen konnen dann deine App installieren.

### Verbotene Inhalte im Listing
- Verwende keine Bewertungen und Erfahrungsberichte in deinem App-Verzeichnis und anderen nicht dafur vorgesehenen App-Verzeichnisbereichen.
- Verwende keine Statistiken oder Daten in der Auflistung deiner App, im Uberblick uber die App und/oder in der App-Einfuhrung. Dies gilt fur uberprufbare und nicht uberprufbare Informationen. Konzentriere dich auf die Vorteile deiner App und vermeide Begriffe wie "die erste", "die beste" oder "die einzige".
- Verwende Shopify-Marken nicht in deinem App-Symbol, Banner oder Screenshots. Shopify-Marken durfen nur verwendet werden, um die Kompatibilitat deiner App mit Shopify gemass den Markenrichtlinien zu kommunizieren.

### Online-Store-Kanal
- Hilf Handlern zu verstehen, ob sie den Online-Store-Kanal (anstelle einer benutzerdefinierten Storefront) verwenden mussen, um den grossten Nutzen aus deiner App zu ziehen. Wenn deine App Funktionen in den Online-Shop eines Handlers einbindet, wahle im Abschnitt "Anforderungen an den Verkaufskanal" deines App-Auflistungsformulars "Handler muss uber einen Online-Shop verfugen".
