# Selesaikan jalur self-hosting, backup, upgrade, dan release images

> Run with: `$swarm` — konfigurasi API, Docker/CI, migrasi, backup/restore, dan journey browser memerlukan beberapa spesialis serta review independen.

## Workspace

Kerjakan di git worktree, jangan di checkout utama.
- Repo: `/Volumes/dityath-workspace/Projects/Wooble`
- Branch: `prompt-1/3-selfhosting-delivery`
- Base: `prompt-1/1-access-data-integrity`. Part 1 harus selesai dan di-commit di branch itu terlebih dahulu. Jika branch tidak ada, belum memiliki commit melampaui base `4b5fa0a`, atau agent 1 belum menyatakan final, berhenti sebelum implementasi dan laporkan dependency; boleh membaca issue sambil menunggu.
- Setup dari root repo setelah verifikasi parent dan branch/path tujuan:
  ```sh
  grep -qxF '.worktrees/' "$(git rev-parse --git-common-dir)/info/exclude" || echo '.worktrees/' >> "$(git rev-parse --git-common-dir)/info/exclude"
  git worktree add .worktrees/prompt-1-3 -b prompt-1/3-selfhosting-delivery prompt-1/1-access-data-integrity
  cd .worktrees/prompt-1-3
  bun install --frozen-lockfile
  ```
- Catat SHA parent. Jangan memakai branch parent yang masih berubah sebagai bukti verifikasi akhir.
- Gunakan env fiktif khusus task. Jika menyalin `.env*` untracked root untuk kebutuhan lokal, jangan cetak/commit isinya dan jangan menggunakan endpoint/data pengguna; test memerlukan env disposable tersendiri.
- Resource: DB prefix acak `wooble_p1_3_`, Compose project unik `wooble-p1-3-<run>`, port web self-host `18083`; API/web browser bila diperlukan `41413`/`5178`. Jangan memakai volume/port dari instalasi pengguna.
- Commit per issue/topik pada branch ini. Jangan merge main, push, publish images/release, deploy, atau hapus worktree.
- Dengan `$swarm`, gunakan branch/base/worktree ini, bukan branch `swarm/*` dari HEAD utama.

## Goal

Selesaikan implementasi lokal jalur issue #6 beserta #17–#23 dengan memakai PR existing dan memperbaiki diagnostic yang membocorkan nilai konfigurasi. Instalasi, backup/restore, dan upgrade harus mempunyai bukti dari lingkungan disposable; publikasi image dan deployment tetap tindakan terpisah.

## Context

- Stack: Bun 1.3.14, Elysia, PostgreSQL 16/Drizzle, React/Vite, Docker Compose, Caddy, GitHub Actions, Biome.
- Baca https://github.com/Dityath/Wooble/issues/6 dan issue #17–#23, `AGENTS.md`, `docs/ai-agents.md`, `docs/roadmap.md` shared release gate.
- `deploy/Dockerfile`, `deploy/Caddyfile`, `compose.selfhost.yml`, `.dockerignore`, `.gitignore`, `.env.selfhost.example` — build dan akses instalasi.
- `apps/api/src/index.ts`, `lib/config.ts`, `lib/web-origins.ts`, `lib/auth.ts`, `modules/auth/routes.ts`, `app.ts` — startup, origins, cookies, trusted proxy, health; `config.ts` berasal dari #30.
- `.github/workflows/docker.yml`, `scripts/selfhost-smoke.ts` — smoke dari #31. `.github/workflows/release.yml` belum tersedia pada snapshot; `.github/release.yml` hanya konfigurasi release notes.
- `docs/self-hosting.md`, `docs/versioning.md`, `docs/testing.md`, `CONTRIBUTING.md` — prosedur dan batas bukti.
- Parent agent 1 membawa PR #26/#27/#28, fix revalidation dan scratch DB, serta integritas event/undo #12. Pertahankan semua perubahan ini.

| PR existing | Issue | Head review |
|---|---|---|
| #24 | #17 | `c145c4a043354b29f4034cfdcaecf39ea00d73e3` |
| #30, base branch #26 | #18 | `407902c22e964849385e5bd8b8fcad1af40e8bdb` |
| #31 | #19 | `6673e2a414e944f00a3f9b6805ca2f507eb3430e` |

CI ketiganya sukses saat snapshot; Docker smoke #31 juga sukses. Itu tidak membuktikan branch gabungan, browser cookie behavior, maupun upgrade ke image baru.

## Design

Sudah disetujui pengguna: jalur 3 dari empat jalur fondasi, bergantung hanya pada jalur 1. Jangan brainstorm ulang pembagian.
- Import perubahan existing dengan merge lokal #24 → #30 → #31, sesudah verifikasi head dan ancestry. Jangan menduplikasi/revert fix #26 dari parent ketika menggabungkan #30:
  ```sh
  git fetch origin pull/24/head:refs/heads/prompt-1-source/pr-24
  git merge --no-ff --no-edit prompt-1-source/pr-24
  git fetch origin pull/30/head:refs/heads/prompt-1-source/pr-30
  git merge --no-ff --no-edit prompt-1-source/pr-30
  git fetch origin pull/31/head:refs/heads/prompt-1-source/pr-31
  git merge --no-ff --no-edit prompt-1-source/pr-31
  ```
- Fix diagnostic #30, kemudian checkpoint implementasi #20 → #21 → #22 → #23 pada branch yang sama. Jangan menambah dependency ke part 2; browser self-host test harus dapat berjalan sendiri.
- Implementasi release workflow mendukung manual dry run yang tidak mempublikasikan. Pengujian restore/update hanya memakai data fiktif dalam stack disposable.
- Ditolak: memakai `main` sebagai versi instalasi, expose API/DB ke host, mematikan Secure cookie agar HTTP LAN bekerja, atau menyamakan API smoke dengan journey login browser.

## Requirements

1. #17/#24: pertahankan exclusion backup/dump/test artifacts tanpa mengecualikan SQL migrations. Verifikasi build context dan final API image dengan sentinel fiktif: dump tidak masuk image, migration SQL tetap ada. Backup memakai lokasi `backups/`, timestamp UTC dan umask ketat; dokumentasikan salinan off-server.
2. Perbaiki #30: `parseWebOrigins`/startup tidak mencetak raw rejected entry, termasuk username/password, token query/fragment, dan malformed URL. Error menyebut setting serta entry index dan alasan yang berguna. Tambah test semua kelas tersebut, bukan hanya password `DATABASE_URL`. Tetap fail-fast atas invalid origins, production HTTP non-loopback, invalid `TRUST_PROXY`, missing production DB/origin, dan invalid port; tidak melemahkan auth/live guard parent.
3. #19/#31: pertahankan Compose config/build/start, health, ports, registration/me/canvas edit, WebSocket presence, foreign Origin refusal, restart dan down/up persistence. Tambah bukti HTML/static assets dan browser login melalui Caddy; jangan inject cookie untuk membuktikan login/cookie policy. Nyatakan terpisah apa yang membuktikan #19 dan apa yang masih diperlukan #6.
4. #20: buat `.github/workflows/release.yml` untuk version tags/manual dry run, CI, build API/web `linux/amd64` dan `linux/arm64`, smoke terhadap image yang dibangun, upgrade previous-version fixture pada volume yang sama, OCI version/commit labels, API non-root, base image pinned sesuai issue, serta third-party notices. Target publikasi `ghcr.io/dityath/wooble-api` dan `ghcr.io/dityath/wooble-web` memakai exact version; draft release hanya pada jalur publish. Dokumentasikan flow dan langkah maintainer membuat GHCR packages public pertama kali di `docs/versioning.md`; jangan mengubah visibility atau menjalankan publish sekarang.
5. Release sebelumnya baru v0.1.0 dan versioned GHCR images belum terbukti tersedia. Sediakan bootstrap upgrade fixture dari source tag v0.1.0 atau fallback yang eksplisit/teruji; jangan membuat upgrade workflow yang diam-diam skip atau langsung pull image yang belum ada. Dokumentasikan batas multi-arch apabila runner lokal hanya membuktikan satu arsitektur.
6. #21: versi diwajibkan via `${WOOBLE_VERSION:?}`, project Compose stabil, source-build/domain overlays, env-driven Caddy HTTPS + WebSocket. Mode local loopback; private network/proxy memakai explicit bind + exact HTTPS origin; domain automatic HTTPS. API/DB tidak publish host ports. Reuse volume v0.1.0 hanya bila tepat satu kandidat sah, tolak pilihan ambigu dan jangan rename/remove volume pengguna. Test discovery memakai volume fiktif.
7. Trusted proxy: jangan percaya spoofed forwarding headers dari sembarang client. Terapkan penentuan IP dari rantai proxy yang terpercaya sesuai #21; test login limit untuk spoofed `X-Forwarded-For`, trusted/untrusted hop, dan akses langsung. Konfigurasi trust harus eksplisit dan sesuai topologi Caddy/proxy yang didukung.
8. #22: `deploy/wooble` menyediakan install/up, status, diagnose, backup, restore, `update <version>`. Health menampilkan versi dan baseline health test diperbarui. Restore memerlukan flag konfirmasi eksplisit, automatic backup sebelum perubahan, stop/start terkelola, dan laporan kegagalan/recovery yang tidak menghapus backup. Update mewajibkan versi, backup, volume preservation dan migrations. Diagnose tidak mencetak secret dan memeriksa origin/bind/HTTPS/WS/migration/health. Masukkan static checks script ke CI dan jalankan command yang relevan dalam Docker smoke workflow; bedakan konfigurasi workflow dari hasil CI yang benar-benar sudah berjalan.
9. Test refusal untuk versi/env ambigu, missing confirmation, failed backup/migration/restore/start, serta preservation data pada upgrade dan restore rehearsal. Destructive test hanya terhadap stack milik task. Cleanup hanya resource yang run ini buat; tidak ada `docker system prune` atau blanket volume removal.
10. #23: tulis ulang guide dengan copyable commands yang benar-benar sesuai implementasi, URL tiap mode, health/diagnose, backup/off-server/restore/update, migration timing, trusted-group limit tanpa email verification/recovery, dan checklist fresh host + second device. Dokumentasikan outcome checklist; bila belum tersedia fresh Linux host/second device, tandai belum terbukti dan jangan nyatakan #6 selesai.
11. Review independen keamanan config/proxy/backup, workflow permissions, upgrade/restore error paths, lisensi dan dokumentasi. Hasil lokal tidak menjadi klaim bahwa workflow baru sudah lulus di GitHub.
12. Serahkan checkpoint #17–#23 dan limitations kepada agent 4. Remote PR #30 baru dapat ditargetkan ulang setelah maintainer mengintegrasikan #26; jangan retarget, merge atau publish sekarang.

## Constraints / Out of scope

- Jangan menyentuh dirty checkout pengguna/worktree lain. Agent lain paralel; jangan revert hasil mereka. Ownership jalur ini deploy/config/release/self-host docs; pertahankan akses/event/undo parent.
- Tidak menjalankan backup/restore/update pada instalasi nyata, menggunakan real account/company data, atau mengubah secret/production services.
- Jangan ubah migration lama atau konfigurasi generated release notes `.github/release.yml` untuk menggantikan workflow.
- Biome source of truth. Tidak menurunkan coverage, menambah ESLint/Prettier, melemahkan cookie/Origin rules, atau publish demi mendapatkan bukti.

## Acceptance criteria

- [ ] Diagnostic invalid origin tidak mengandung raw secret; regression test lulus.
- [ ] Backup sentinel tidak masuk build/image dan migrations tetap tersedia.
- [ ] Semua acceptance #20–#23 ditangani atau mempunyai batas bukti yang jelas; #6 tidak ditutup prematur.
- [ ] Smoke API/WS dan browser login/static asset melalui supported origin terbukti terpisah.
- [ ] Restore/update rehearsal mempertahankan content pada stack disposable, dan kegagalan punya recovery path.
- [ ] Mode akses/port/trusted proxy/volume ambiguity diuji; tidak ada API/DB host exposure.
- [ ] Workflow dry-run aman tanpa publishing; bootstrap previous-release upgrade tidak bergantung image yang belum ada.
- [ ] Lint/format/typecheck/build/test/coverage dan review final lulus; state main/remote/user data tidak berubah.

## Verify

Set `DATABASE_URL` ke DB disposable unik yang dibuat task, bukan env pengguna. Gunakan Compose project/env milik task. File env test tidak boleh di-commit.

```sh
bun install --frozen-lockfile
bun run lint
bun run format:check
bun run typecheck
bun run build
bun run db:migrate
bun test apps/api/tests/*.test.ts
bun test packages/*/tests
bun run test:web
bun run coverage --enforce
docker compose --env-file .env.selfhost.test -f compose.selfhost.yml config -q
git diff --check
git status --short
```

Sesudah membaca CLI argumen `scripts/selfhost-smoke.ts`, jalankan ketiga phase `setup`, `verify`, `ports` dengan origin/state task. Jalankan build, restore/upgrade dan browser checks memakai command final yang didokumentasikan; catat command persis serta hasilnya. Jangan menjalankan `docker compose config` tanpa `-q` karena dapat mencetak env. Jika Docker/runner/HTTPS/second-device tidak tersedia, lanjutkan pekerjaan yang bisa diverifikasi dan laporkan batas secara spesifik.

## Assumptions

- Fresh Linux host, domain HTTPS dan runner multi-arch belum dipastikan tersedia. Tidak ada izin publishing/deploy tersirat dari kebutuhan evidence tersebut.
