# Amankan block editor, viewer documentation, dan browser CI

> Run with: `$swarm` — lifecycle editor, akses pengguna, draft recovery, accessibility, dan browser test melintasi beberapa area frontend.

## Workspace

Kerjakan di git worktree, jangan di checkout utama.
- Repo: `/Volumes/dityath-workspace/Projects/Wooble`
- Branch: `prompt-1/2-documentation-safety`
- Base: `4b5fa0a73baba300004da5caf661080c8750e4ab` (`main` snapshot 13 Oktober 2026); tidak bergantung pada prompt lain.
- Setup dari root repo setelah memeriksa branch/path belum ada:
  ```sh
  grep -qxF '.worktrees/' "$(git rev-parse --git-common-dir)/info/exclude" || echo '.worktrees/' >> "$(git rev-parse --git-common-dir)/info/exclude"
  git worktree add .worktrees/prompt-1-2 -b prompt-1/2-documentation-safety 4b5fa0a73baba300004da5caf661080c8750e4ab
  cd .worktrees/prompt-1-2
  ```
- Import commit editor yang sudah ada secara lokal, bukan dirty diff:
  ```sh
  git merge --no-ff --no-edit 997c8224783dbe32009a0f982624cdd310f677f1
  bun install --frozen-lockfile
  ```
- Gunakan env test fiktif/untracked. Jika perlu menyalin `.env*` root, jangan cetak/commit isi dan override seluruh URL test agar tidak menyentuh DB pengguna. Jangan gunakan script test dengan nama database default bersama.
- Resource: prefix DB acak per run `wooble_p1_2_`; browser API `41412`, web `5177`. Jangan reuse server atau mematikan proses lain.
- Commit per topik di branch ini; jangan merge ke main, push, atau hapus worktree.
- Dengan `$swarm`, gunakan branch/base/worktree ini, bukan worktree `swarm/*` dari checkout utama.

## Goal

Selesaikan issue #9 sebagai v0.2.0 part 1 dengan menyertakan viewer fix #13 dan browser CI #14 yang sudah tersedia. Pengguna harus dapat mempertahankan dan memulihkan edit yang belum tersimpan, sementara viewer/link guest tetap hanya membaca.

## Context

- Stack: Bun 1.3.14, React 19/Vite, TanStack Query/Router, TipTap 3/ProseMirror, Markdown, Elysia/PostgreSQL, Playwright, Biome.
- Issue utama: https://github.com/Dityath/Wooble/issues/9; baca #13, #14, `AGENTS.md`, `docs/ai-agents.md`.
- `apps/web/src/features/inspector/rich-documentation.tsx` — lazy-loading boundary; saat snapshot masih mere-export `MarkdownContent`.
- `apps/web/src/features/inspector/rich-documentation-editor.tsx` — autosave, external update dan unmount lifecycle.
- `apps/web/src/features/inspector/documentation/documentation-editor.tsx`, `slash-menu.tsx`, `slash-menu-list.tsx`, `slash-commands.ts`, `markdown-content.tsx`, `unsupported-markdown.ts` — editor, aksesibilitas dan fidelity.
- `apps/web/src/features/canvas/canvas-page.tsx`, `inspector-panel.tsx`, `apps/web/src/features/entity/entity-detail-page.tsx` — object context dan read/write surfaces. `inspector-panel.tsx` berada di `features/inspector/`.
- `apps/web/src/features/auth`, `apps/web/src/lib/api.ts` — identity, logout, error API; baca pola aktual sebelum memasang draft cleanup.
- `packages/contracts/src/entity.ts`, `connection.ts` — `metadata.documentation` tetap Markdown dengan `trim().max(20000)`.
- `apps/web/tests/support`, `apps/web/tests`, `apps/web/e2e` — pola unit/component dan real-browser journeys.
- `apps/web/playwright.config.ts`, `.github/workflows/ci.yml`, `apps/api/src/modules/auth/routes.ts` — perubahan browser CI dari PR #29.
- `docs/product.md`, `docs/decisions/documentation-storage.md`, `docs/testing.md` — known limits dan interim Markdown-first decision.

PR existing: #25 → #13 head `63920de9f5c99106830625001cb8a260d1f07bcf`; #29 → #14 head `365f454163708219f5d0f4c0d1bbe830c70571f2`. Keduanya draft, CI sukses saat review; tidak ditemukan blocker dari review sumber. Browser check #29 hanya membuktikan suite pada head-nya, belum suite editor gabungan.

## Design

Sudah disetujui pengguna: jalur 2 dari empat jalur fondasi; jangan brainstorm ulang cakupan.
- Pertahankan commit editor yang sudah ada, tambahkan fix commit tanpa rewrite history. Import PR #25 lalu #29 ke worktree ini dengan merge lokal, setelah verifikasi head/ancestry:
  ```sh
  git fetch origin pull/25/head:refs/heads/prompt-1-source/pr-25
  git merge --no-ff --no-edit prompt-1-source/pr-25
  git fetch origin pull/29/head:refs/heads/prompt-1-source/pr-29
  git merge --no-ff --no-edit prompt-1-source/pr-29
  bun install --frozen-lockfile
  ```
- Gunakan recoverable per-user/per-object draft dan save state yang eksplisit, dengan server authorization tetap sumber kebenaran. Rincian storage draft dipilih setelah membaca pola aplikasi; harus memenuhi logout/revocation behavior.
- Pertahankan Markdown-first, unsupported source fallback, batas 20000 karakter, dan kontrak API/DB.
- Ditolak: mengganti persistence menjadi Yjs, menganggap autosave cukup tanpa recovery, atau mengerjakan kontrak/schema/comment dalam jalur ini.

## Requirements

1. Baca seluruh acceptance #9 dan periksa ulang bug pada baseline gabungan. Jangan menghapus perbaikan Markdown fidelity, paste/drop table, source fallback, atau read-mode focus yang sudah ada.
2. Draft recovery mencakup over-limit text, debounce, in-flight save, failed unmount save, perpindahan object/selection, close dialog, refresh, dan error jaringan/400/403. Key mencakup user serta object kind/id agar entity dan connection tidak tertukar. Bersihkan draft pada logout; jangan tampilkan/restore draft sebelum identity dan current write access diverifikasi, termasuk setelah revoke atau pergantian account.
3. Close dengan edit belum tersimpan/gagal harus dikonfirmasi atau diblokir dengan jalur recovery. Over-limit menampilkan jumlah kelebihan dan tidak menawarkan Retry yang pasti gagal. `beforeunload` aktif selama unsaved/in-flight dan dilepas setelah aman.
4. Test parked external update setelah blur-initiated save; jika bug terbukti perbaiki tanpa menimpa local draft atau server update diam-diam. Jelaskan bahwa co-editing masih last-write-wins dalam increment ini.
5. Lazy editor mempunyai error boundary dengan Retry dan read-only Markdown fallback. Simulasikan chunk failure/offline tanpa menjatuhkan seluruh halaman.
6. Respons 403 mengubah editor menjadi read-only dengan penjelasan, tidak infinite retry. Jangan memulihkan konten sensitif kepada user yang sudah tidak berhak. Bedakan kegagalan transient dengan validasi permanen.
7. Slash menu mengimplementasikan `aria-expanded`, `aria-haspopup="listbox"`, `aria-autocomplete`, pengumuman active option/result count, serta focus target jelas setelah Escape. Slash di paragraf berisi teks menyisipkan block pada caret; paragraf kosong boleh dikonversi.
8. Test `javascript:` dan `data:` dari pasted Markdown/HTML tidak menjadi link aktif dalam editor maupun `MarkdownContent`. Gunakan fixture fiktif; jangan merusak code examples/escaped literals.
9. PR #25 tetap menampilkan hanya dokumentasi selected connection dari authorized canvas graph, empty state yang sesuai reader, dan tanpa editing control. Uji viewer dan signed-out link guest; browser journey mencakup dokumentasi panjang/code/table. Jangan menganggap import rusak hanya karena file berpindah—verifikasi re-export aktual.
10. PR #29 tetap menyalakan real-browser CI dengan PostgreSQL disposable, `bun --no-env-file`, database eksplisit, `NODE_ENV=test`, test-only rate limit yang ditolak di production, failure artifacts dan summary. Jalankan seluruh suite gabungan termasuk dokumentasi. Jangan melonggarkan production rate limit, menurunkan coverage, atau memakai retry untuk menyembunyikan flaky test.
11. Update known limits `docs/product.md` sesuai perilaku yang benar. Jangan klaim import `.md`, collaborative presence atau CRDT sudah selesai. Berikan release mapping v0.2.0 part 1 kepada agent 4.
12. Review independen final diff dan browser findings; lakukan fix loop sebelum checkpoint akhir. Agent 4 saja yang mengubah metadata GitHub.

## Constraints / Out of scope

- Jangan menyentuh dirty checkout utama: perubahan Auto Neat/connector/contract/test pengguna bukan bagian dari issue #9.
- Bekerja bersama agent lain; jangan revert pekerjaan mereka. Miliki frontend editor, draft recovery dan browser CI. Agent 1 memiliki API access/event/undo; koordinasikan overlap auth routes dan docs/testing saat integrasi.
- Jangan mengubah API/schema penyimpanan dokumentasi atau menaikkan batas 20000 hanya untuk meloloskan test.
- Semua akses diuji lewat server sebenarnya untuk journey penting; mock component bukan bukti revocation end-to-end.
- Tidak merge ke main atau branch integrasi bersama; merge lokal baseline ke branch task yang disebut dalam Workspace/Design diperbolehkan. Tidak push, publish, deploy, atau remote issue edit. Tidak copy secret ke prompt, commit, screenshot, atau log.

## Acceptance criteria

- [ ] Setiap acceptance #9 terpenuhi dan ditautkan ke test/evidence.
- [ ] Konten pending/failure/over-limit dapat dipulihkan oleh user yang masih berhak, dan tidak bocor lintas account/object.
- [ ] Close/refresh/selection change serta blur/external-update race teruji.
- [ ] Slash insertion, keyboard/focus, source fallback dan malicious URL test lulus.
- [ ] Viewer dan link guest membaca connection documentation tanpa write controls/API permission bypass.
- [ ] Browser suite editor dan viewer gabungan berjalan dengan database serta port unik; hasil console dan kegagalan dilaporkan.
- [ ] Lint/format/typecheck/build/test/coverage relevan lulus; review independen selesai.
- [ ] Commit lokal per topik dan known limits jujur; tidak ada klaim bahwa seluruh v0.2.0 selesai.

## Verify

Provision PostgreSQL disposable unik; set `DATABASE_URL` dan `BROWSER_TEST_DATABASE_URL` ke DB test yang telah dimigrasikan. Set `BROWSER_TEST_API_PORT=41412` dan `BROWSER_TEST_WEB_PORT=5177`; pastikan semua env berasal dari run ini.

```sh
bun run lint
bun run format:check
bun run typecheck
bun run build
bun run db:migrate
bun run test:web
bun test packages/*/tests
bun test apps/api/tests/*.test.ts
bun run coverage --enforce
bun run --cwd apps/web test:browser
git diff --check
git status --short
```

Jika Chromium belum tersedia, instal dari `apps/web` dengan `bunx playwright install chromium`; gunakan `BROWSER_TEST_CHROMIUM` hanya bila menjelaskan versi browser yang berbeda. Catat source/unit, real DB, browser, dan CI remote secara terpisah. Jika jalur browser tidak dapat dijalankan, laporkan sebagai belum terbukti, bukan pass.

## Assumptions

- Commit editor `997c8224783dbe32009a0f982624cdd310f677f1` tersedia lokal. Jika hilang, cari branch yang dimaksud dan laporkan; jangan mengambil dirty diff pengguna sebagai pengganti.
- Storage draft final belum dipilih; harus mematuhi semua syarat authorization/retention di atas, dengan alasan desain tercatat.
