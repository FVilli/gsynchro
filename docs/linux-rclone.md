# rclone per gsynchro

`gsynchro` usa Google Drive come normale filesystem locale.

Google Drive viene montato tramite `rclone` in:

```text
~/GDrive
```

Lo script `gsynchro` non usa direttamente API Google Drive.

---

# 1. Installazione

Su Ubuntu:

```bash
sudo -v
curl https://rclone.org/install.sh | sudo bash
```

Verifica:

```bash
rclone version
```

---

# 2. Configurazione Google Drive

Avvia:

```bash
rclone config
```

Crea un nuovo remote:

```text
n) New remote
```

Nome consigliato:

```text
gdrive
```

Tipo:

```text
Google Drive
```

Per Google OAuth è consigliato utilizzare un proprio:

```text
client_id
client_secret
```

creato nella Google Cloud Console.

Scope:

```text
1 / Full access all files
```

Service account:

```text
lasciare vuoto
```

Advanced config:

```text
No
```

Autenticazione tramite browser:

```text
Yes
```

Per un normale "Il mio Drive":

```text
Shared Drive: No
```

Al termine salvare il remote.

---

# 3. Verifica del remote

Elenco directory:

```bash
rclone lsd gdrive:
```

Elenco file e directory:

```bash
rclone lsf gdrive:
```

Informazioni quota:

```bash
rclone about gdrive:
```

Esempio:

```bash
rclone lsd gdrive:develop
```

---

# 4. Mount locale

Creare il mount point:

```bash
mkdir -p ~/GDrive
```

Avvio manuale:

```bash
rclone mount gdrive: ~/GDrive --vfs-cache-mode writes
```

Il comando resta in foreground.

In un altro terminale:

```bash
ls ~/GDrive
```

I file e le cartelle di Google Drive devono apparire con nomi normali.

---

# 5. Test di scrittura

Esempio:

```bash
mkdir -p ~/GDrive/develop/rclone-test

echo "test" > ~/GDrive/develop/rclone-test/test.md

cat ~/GDrive/develop/rclone-test/test.md

mv \
  ~/GDrive/develop/rclone-test/test.md \
  ~/GDrive/develop/rclone-test/test2.md

rm ~/GDrive/develop/rclone-test/test2.md
```

Verificare anche dal browser Google Drive.

---

# 6. Mount automatico con systemd

Creare:

```text
~/.config/systemd/user/rclone-gdrive.service
```

Contenuto:

```ini
[Unit]
Description=Rclone Google Drive mount
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/rclone mount gdrive: %h/GDrive \
  --vfs-cache-mode writes \
  --dir-cache-time 12h \
  --poll-interval 1m \
  --umask 022

ExecStop=/bin/fusermount3 -u %h/GDrive

Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Ricaricare systemd:

```bash
systemctl --user daemon-reload
```

Abilitare e avviare:

```bash
systemctl --user enable --now rclone-gdrive.service
```

Verificare:

```bash
systemctl --user status rclone-gdrive.service
```

Verificare il mount:

```bash
mount | grep GDrive
```

Log realtime:

```bash
journalctl --user -u rclone-gdrive.service -f
```

Riavvio manuale:

```bash
systemctl --user restart rclone-gdrive.service
```

Stop:

```bash
systemctl --user stop rclone-gdrive.service
```

Start:

```bash
systemctl --user start rclone-gdrive.service
```

---

# 7. Smontaggio manuale

Se il mount è stato avviato manualmente:

```bash
fusermount3 -u ~/GDrive
```

Oppure interrompere il processo `rclone mount` con:

```text
Ctrl+C
```

Non avviare contemporaneamente il mount manuale e quello systemd sullo stesso `~/GDrive`.

---

# 8. Configurazione gsynchro

Esempio `.gsynchro/gsynchro.yml`:

```yaml
destination: /home/federico/GDrive/develop/AEP

debounce: 5

items:
  - "*.md"
  - "docs/**/*.md"
  - "stack/**/*.md"
  - "tasks/**/*.md"
  - "usecases/**/*.md"
```

Il mount rclone deve essere disponibile prima di avviare:

```bash
npm run gsynchro
```

---

# 9. GNOME Online Accounts

Se Google Drive è già configurato tramite GNOME Online Accounts, l'integrazione Files può essere disabilitata per evitare un doppio accesso allo stesso Drive.

Percorso indicativo:

```text
Settings
→ Online Accounts
→ Google
→ Files: OFF
```

È possibile lasciare attivi gli altri servizi Google.

---

# 10. Comandi rclone utili

Elencare directory:

```bash
rclone lsd gdrive:
```

Elencare contenuti:

```bash
rclone lsf gdrive:
```

Copiare senza cancellare dalla destinazione:

```bash
rclone copy sorgente gdrive:destinazione
```

Sincronizzare rendendo la destinazione uguale alla sorgente:

```bash
rclone sync sorgente gdrive:destinazione
```

ATTENZIONE: `sync` può cancellare file nella destinazione.

Durante i test usare preferibilmente:

```bash
rclone sync --interactive sorgente gdrive:destinazione
```

Mostrare la configurazione:

```bash
rclone config show
```

Mostrare i path usati da rclone:

```bash
rclone config paths
```

Verificare il remote:

```bash
rclone about gdrive:
```

---

# Architettura

```text
Google Drive
    ↕
  rclone
    ↕
 ~/GDrive
    ↕
 gsynchro
    ↕
repository Git
```

`rclone` si occupa esclusivamente del collegamento tra Google Drive e il filesystem locale.

`gsynchro` si occupa esclusivamente della sincronizzazione selettiva e bidirezionale tra il repository e la cartella montata in `~/GDrive`.