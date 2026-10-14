# Putuskan model kolaborasi dan selaraskan issue/Project menuju v0.5.0

> Run with: `$swarm` — ADR lintas persistence/akses/editor serta audit backlog memerlukan riset dan review independen; tidak mengimplementasikan runtime fitur.

## Workspace

Kerjakan perubahan repo di git worktree, jangan di checkout utama.
- Repo: `/Volumes/dityath-workspace/Projects/Wooble`
- Branch: `prompt-1/4-collaboration-roadmap`
- Base: `4b5fa0a73baba300004da5caf661080c8750e4ab` (`main` snapshot); tidak bergantung pada prompt lain.
- Setup dari root repo setelah memastikan branch/path belum ada:
  ```sh
  grep -qxF '.worktrees/' "$(git rev-parse --git-common-dir)/info/exclude" || echo '.worktrees/' >> "$(git rev-parse --git-common-dir)/info/exclude"
  git worktree add .worktrees/prompt-1-4 -b prompt-1/4-collaboration-roadmap 4b5fa0a73baba300004da5caf661080c8750e4ab
  cd .worktrees/prompt-1-4
  bun install --frozen-lockfile
  ```
- `.env*` pengguna tidak diperlukan untuk dokumentasi/spike. Jika ada kebutuhan menyalin env untracked, jangan cetak/commit isinya, dan ganti akses eksternal/DB dengan resource fiktif task. Spike dijalankan di direktori temporary di luar repo.
- Resource bila diperlukan: prefix `wooble_p1_4_`, WS spike `41424`, API `41414`, web `5179`. Jangan reuse server/DB milik agent lain.
- Commit perubahan docs per topik pada branch ini. Jangan merge ke main, push, publish release/image, deploy, atau hapus worktree.
- Dengan `$swarm`, gunakan branch/base/worktree ini. Jangan dispatch implementasi runtime collaboration; pakai riset dan review docs/kontrak.

## Goal

Selesaikan keputusan model kolaborasi issue #16 dengan spike yang dapat diaudit, dan cocokkan GitHub Issues/Project dengan PR serta pekerjaan tersisa sampai v0.5.0. Hasil tracking harus membedakan planned, pekerjaan aktif, PR draft, merged, dan released.

## Context

- Stack: Bun 1.3.14, Elysia WebSocket, TipTap/ProseMirror, Markdown, PostgreSQL/Drizzle, TypeScript. Kandidat #16: Yjs 13 + `y-protocols` melalui API Wooble sendiri.
- Baca `AGENTS.md`, `docs/ai-agents.md`, `docs/roadmap.md`, `docs/product.md`, `docs/reporting-issues.md`, `docs/architecture.md`, `docs/testing.md`, `docs/versioning.md`.
- Issue: https://github.com/Dityath/Wooble/issues/16. Interim `docs/decisions/documentation-storage.md` ada di commit editor `997c8224783dbe32009a0f982624cdd310f677f1`; baca dengan `git show` jika belum ada pada main, jangan merge seluruh branch editor ke jalur docs ini.
- `apps/api/src/lib/live.ts`, `lib/auth.ts`, entity/connection routes, canvas activity/undo, `packages/db/src/schema` — kontrak yang harus diperhitungkan; agent 1 sedang menambahkan registry/integritas #12.
- `packages/contracts/src/entity.ts`, `connection.ts` — Markdown max 20000, `contractBody`/`schemaSql` max 100000, metadata update existing.
- `apps/web/src/features/inspector/contract-editor.tsx`, `database-schema.tsx`, `database-schema-parser.ts` — fondasi kontrak/schema saat ini; bukan fitur final roadmap.
- Project URL: https://github.com/users/Dityath/projects/1 ; roadmap view `/views/2`.
- Project id `PVT_kwHOA0GxUM4Bk_Ik`; Status field `PVTSSF_lAHOA0GxUM4Bk_Ikzhjtqzk`: Todo `f75ad846`, In Progress `47fc9ee4`, Done `98236657`. Selalu verifikasi ulang ID/nama sebelum write.
- Project saat snapshot hanya lima DraftIssue release cards, semua Todo, tanpa issue implementation items. Ini format yang disengaja; pertahankan kartu release dan kriteria lengkapnya.

Pemetaan audit 13 Oktober 2026:

| PR | Issue | State / note |
|---|---|---|
| #24 | #17 | Draft, backup exclusion; tidak ditemukan blocker sumber |
| #25 | #13 | Draft, viewer documentation; tidak ditemukan blocker sumber |
| #26 | #10 | Draft; perlu fail-closed saat immediate socket recheck error |
| #27 | #11 | Draft; scope read-before-placement sesuai, keputusan model multi-canvas terpisah |
| #28 | #15 | Draft; scratch DB deterministic pre-drop tidak aman untuk parallel tests |
| #29 | #14 | Draft; browser CI hijau, bukan validasi editor branch gabungan |
| #30 | #18 | Draft, stacked di #26; raw WEB_ORIGIN bocor lewat diagnostic |
| #31 | #19 | Draft; Docker smoke hijau, belum membuktikan browser/second-device/upgrade #6 |

Semua issue terbuka masih `status:ready`, tanpa assignee/milestone/projectItems. GitHub `closingIssuesReferences` cocok untuk tujuh PR berbasis main; #30 kosong meskipun body `Closes #18` karena base feature branch. Required checks main hanya `Code quality` dan `Tests`; Browser journeys/Docker smoke belum wajib. Rilis publik baru v0.1.0 preview.

## Design

Sudah disetujui pengguna: jalur 4 adalah ADR kolaborasi #16 serta pemetaan backlog/Project, berjalan paralel dengan implementasi fondasi. Jangan brainstorm ulang pembagian.
- Ambil snapshot live, susun mapping/checklist, lalu lakukan pembaruan GitHub yang diminta pengguna secara idempotent. Jalur ini satu-satunya pemilik penyesuaian issue/Project.
- Pertahankan Project sebagai roadmap release: tautkan issue/PR dan shared prerequisites dalam body kartu. Tidak membuat Project kedua atau mengganti draft cards menjadi issue secara massal.
- Buat issue pelaksanaan yang belum ada dengan acceptance observabel, dependency dan release target, setelah dedupe. Keputusan teknis yang belum teruji ditandai needs-triage, bukan dianggap diterima/selesai.
- Tulis `docs/decisions/collaboration-sync.md` dan tautan dari architecture setelah spike. Runtime/dependency collaboration tidak ditambahkan ke repo dalam batch ini.
- Ditolak: menandai release Done karena CI PR hijau, menciptakan tanggal/assignee fiktif, memaksa satu agent mengerjakan seluruh v0.2–v0.5 dalam satu task, atau menganggap Markdown-first sudah collaborative.

## Requirements

1. Refresh open/closed issues, PR heads/base/closing refs/checks/reviews, Project cards, milestones, release tags, main SHA. Bandingkan dengan snapshot; jangan mengganti edit maintainer yang terjadi setelah prompt dibuat.
2. Tulis ADR #16: alasan memilih atau menolak Yjs 13 + `y-protocols` di Elysia API dibanding Hocuspocus terpisah; room identity terkait authorized canvas context dan semantic object, read-only updates diblokir server, awareness terpisah dari durable data, current authorization/revocation sebelum send/receive.
3. Rancangan `collab_documents`: workspace FK cascade, object kind/id/field, uniqueness, Yjs state, Markdown mirror, original Markdown/hash saat bootstrap pertama, bootstrap satu kali dengan row lock, retention cocok dengan delete/undo. Uraikan migration/backfill/recovery/rollback, size bounds, validation, server memory/connection caps dan batas single instance. Jangan mengarang SQL yang sudah diimplementasikan.
4. Uraikan legacy `PATCH metadata.documentation` melalui server replace dengan base-hash precondition 409, kompatibilitas reader/export, activity/undo exclusions dan registry #12, Yjs-aware undo serta StarterKit `undoRedo` disabled. Dokumentasikan kebutuhan perubahan API tersebut sebagai future implementation, bukan mengubah kontrak sekarang. Pertimbangkan stale clients, reconnect, permission revoke dan mixed legacy/collab writers.
5. Jelaskan reuse untuk v0.3 presence/conflict dan v0.5 `Y.RelativePosition` text anchors. Stable identity table/column/contract section serta orphan handling harus menjadi dependency backlog, bukan janji otomatis selesai.
6. Spike di luar repo: dua client `y-protocols` melalui route Elysia pada Bun 1.3.14, binary send/receive dan convergence, disconnect/reconnect serta rejection read-only jika dicakup. Catat versi package, license, command, output ringkas, apa yang diuji dan tidak. Konsultasikan dokumentasi resmi terkini; jangan mengubah bun.lock/package.json repo. Spike gagal tetap dicatat jujur dan menjadi blocker keputusan terkait.
7. Untuk issue existing dengan PR aktif, pertahankan acceptance asli; tambahkan mapping PR/head/review status yang ringkas dan dependency, sesuaikan label `status:ready` ke `status:claimed` hanya bila pekerjaan aktif terverifikasi. Jangan mengarang assignee. Jangan menutup issue atau mencentang kriteria yang belum dibuktikan; commit lokal agent tidak berarti PR remote sudah diperbaiki.
8. Project v0.2.0 dapat berstatus In Progress berdasarkan #9/#13 dan pekerjaan aktual; jelaskan shared prerequisite #10–#16 serta self-hosting #6/#17–#23. v0.3–v0.5 tetap Todo kecuali ada implementasi khususnya yang terverifikasi. Pertahankan target asli dengan catatan revisable/overdue untuk 10 Oktober; jangan menetapkan tanggal baru tanpa dasar kapasitas yang disepakati. Jangan mengubah v0.6 menjadi bagian komitmen batch ini.
9. Lengkapi backlog v0.2: collaboration persistence/server sync/access/revocation; TipTap co-edit/presence/carets/reconnect; Markdown file import preview/export/fidelity; migration dan end-to-end multi-user/release gate. Reuse #9/#16 dan issue test/foundation yang ada, jangan duplikasi.
10. Lengkapi backlog v0.3: explicit contract format semantic connection; OpenAPI supported version/validation/source-preserving visual edits; Protobuf parse/services/messages/dependency diagnostics; creation/export; section presence/conflict/reconnect; authorization and integration/browser tests. Event contracts perlu format-aware source view, bukan janji rich AsyncAPI editor atau external registry sync.
11. Lengkapi backlog v0.4: semantic table/column/key IDs terpisah dari layout; PostgreSQL DDL subset beserta unsupported/unresolved diagnostics; visual CRUD/relationships/nullability/default/keys; title/purpose/export; conflicts/permissions/multi-canvas/persistence tests. Tidak otomatis menghasilkan service contract dari table.
12. Lengkapi backlog v0.5: thread/reply/resolve/reopen persistence dan routes; entity/connection/canvas/doc/contract/schema anchors; relative text positions serta orphan recovery; eligible mentions dan in-app inbox; authorization/no private-content leakage; browser journeys perubahan/deletion anchor. Dependensi ke v0.2–v0.4 harus eksplisit.
13. Catat keputusan follow-up akses multi-canvas yang terlihat dari #27: read access cukup untuk placement, tetapi aturan write pada semua canvas dapat mencabut source editor. Buat/tautkan issue keputusan produk/akses dengan contoh fiktif pada tingkat kebutuhan, jangan mempublikasikan exploit detail baru. Jangan mengubah #11 diam-diam.
14. Setiap issue baru memiliki outcome, scope, acceptance, permission matrix relevan, migration/data risk, Verify, dependency, dan release association. Gunakan form/kategori label existing. Jangan menetapkan semua issue sebagai ready apabila ADR/dependency masih belum diputuskan.
15. Update GitHub secara minimum dan idempotent: dedupe judul/link, read-before-write, simpan acceptance/konten pengguna. Gunakan structured API atau body file lokal untracked yang tidak mengandung secret jika diperlukan; jangan interpolasi shell body mentah. Re-read sesudah write untuk memverifikasi. Tidak mengirim komentar/review request/mention atau notifikasi tambahan sebagai bagian sinkronisasi.
16. Dokumentasikan mapping acceptance→issue→PR→bukti, gap yang belum mempunyai implementation, review findings lokal vs remote, dan urutan release. Review independen ADR/backlog memeriksa security, persistence, dependency serta scope. Commit docs lokal; laporkan URL GitHub yang benar-benar diubah. Jika write GitHub tidak tersedia, laporkan tepat apa yang belum tersinkron, jangan mengklaim berhasil.

## Constraints / Out of scope

- User meminta penyesuaian issue/Project: boleh update metadata/body issue/kartu existing dan membuat scoped follow-up issues setelah dedupe. Tidak ada izin merge PR, publish code/image/release, mengubah branch protection/visibility/permissions, menghapus issue/card, menutup pekerjaan belum selesai, atau menugaskan orang tanpa persetujuan mereka.
- Agent 1/2/3 memiliki implementasi. Jangan mengubah source/runtime/dependencies/migrations atau mengambil dirty diff pengguna. Jika hasil agent lain belum tersedia, cantumkan pending dan lanjutkan bagian independen.
- Pertahankan Markdown-first sebagai perilaku saat ini sampai implementasi collaboration terpisah diterima. Jangan memperlakukan ADR sebagai bukti runtime.
- Gunakan sumber resmi untuk API/library research. Jangan menaruh secret, data nyata, endpoint privat, atau exploit detail sensitif di public GitHub.

## Acceptance criteria

- [ ] ADR #16 ada, ditautkan dari architecture, mencatat keputusan, package licenses, spike evidence dan limitation.
- [ ] Tidak ada dependency/runtime change dalam branch ini; spike terpisah dari repo.
- [ ] Delapan PR dipetakan ke issue yang benar, #30 stack dan closing-reference behavior dijelaskan.
- [ ] Issue/Project mencerminkan state aktual; tidak ada Done/closed/assignee/target date yang dibuat-buat.
- [ ] Setiap acceptance v0.2–v0.5 punya issue pelaksanaan atau gap eksplisit dengan dependency; tidak ada duplikasi pekerjaan PR existing.
- [ ] Keputusan akses multi-canvas dan shared release gates tetap terlihat.
- [ ] Review independen ADR/backlog selesai; semua write GitHub diverifikasi dengan read-back dan URL dilaporkan.

## Verify

```sh
gh pr list --repo Dityath/Wooble --state open --limit 100 --json number,title,headRefOid,baseRefName,closingIssuesReferences,isDraft,statusCheckRollup
gh issue list --repo Dityath/Wooble --state all --limit 200 --json number,title,state,labels,milestone,projectItems
gh project item-list 1 --owner Dityath --limit 100 --format json
gh project field-list 1 --owner Dityath --format json
gh release list --repo Dityath/Wooble --limit 30
bun run lint
bun run format:check
git diff --check
git status --short
```

Paginate bila jumlah item mencapai limit; jangan mengambil list terpotong sebagai backlog lengkap. Typecheck/build/DB tests tidak membuktikan ADR dan tidak wajib untuk docs-only change; spike mempunyai command serta hasil tersendiri yang harus dicatat. Validasi link/path dan pastikan `git diff --name-only` hanya memuat docs yang diizinkan. Jangan memakai status CI lama sebagai bukti setelah head berubah.

## Assumptions

- Akses GitHub Project write dan issue edit belum diuji pada agent ini. User sudah meminta sinkronisasi; bila tools memerlukan approval tambahan, jelaskan aksi dan batas yang tepat tanpa mengarang hasil.
- Tidak ada komitmen tanggal baru atau pemilik manusia untuk feature backlog. Kapasitas empat agent dipakai pada batch fondasi ini, bukan jaminan tenggat v0.5.0.
