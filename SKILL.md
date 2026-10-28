---
name: skill-library-manager
description: Use when the user wants to install a Skill into a managed library, sync installed Skills, maintain Chinese display metadata and categories, inspect original English metadata, rebuild the Skill index, or open the local Skill management UI.
---

# Skill Library Manager

## Overview

Manage installed Skills as one catalog. Treat the downloaded `SKILL.md` frontmatter as immutable source metadata, keep Chinese UI metadata as an editable layer, and require validation before writing any managed files.

## Choose an Operation

| Request | Operation |
| --- | --- |
| Install or download a Skill | Install, then continue directly into sync |
| Find newly installed or updated Skills | Sync |
| View or edit names and categories | Open the local UI |
| Rebuild or audit the library | Sync with validation |

## Install and Enroll

1. **REQUIRED SUB-SKILL:** Invoke `$skill-installer` to perform the installation. Do not reproduce or bypass its installation workflow.
2. If installation fails or is cancelled, stop without creating a catalog entry.
3. Immediately before installation, run `node scripts/manager.mjs snapshot --json`.
4. After a successful install, run `node scripts/manager.mjs scan --json`, then `node scripts/manager.mjs changes --json`. Treat every record in `new` and `changed` as part of this managed installation.
5. Generate Chinese metadata and a category for every new or changed record, then use the apply command documented below. Do not report installation complete until enrollment finishes.
6. Read `data/settings.json`. Auto-apply generated localization for `personal` and `user` sources; require confirmation for `plugin`, `system`, `project`, and unknown sources unless the saved setting says otherwise.
7. For confirmation-required sources, present the Chinese metadata and category as a draft and wait for approval.
8. Apply permitted metadata, rebuild the index, validate, and report the installed Skill's Chinese display name, English invocation name, category, and source.

Installing outside this manager cannot trigger it automatically. Detect those Skills on the next explicit sync or whenever the UI opens.

## Sync Workflow

1. Scan the supported personal, system, plugin-cache, and project Skill roots for `SKILL.md` files.
2. Read each Skill's frontmatter `name` and `description`. Preserve them verbatim as `original_name` and `original_description`; never translate, overwrite, or derive the invocation name from Chinese metadata.
3. Read existing `agents/openai.yaml` when present. Preserve every unrelated field.
4. Match entries by stable source identity and content fingerprint rather than a versioned plugin-cache path alone.
5. For each new or changed Skill, use Codex to propose:
   - a concise Chinese `display_name`;
   - a natural Chinese `short_description` between 25 and 64 characters;
   - exactly one category from `data/categories.json`.
6. Keep both language layers in `data/catalog.json`: editable Chinese display fields and read-only original English frontmatter fields.
7. Consult `data/settings.json`, then write only auto-approved or explicitly approved Chinese `display_name` and `short_description` values to the Skill's `agents/openai.yaml`. Preserve icons, colors, prompts, dependencies, policy, and unknown fields.
8. Mark missing Skills unavailable instead of deleting their history. Detect plugin upgrades and reapply approved Chinese metadata only after identity and validation checks succeed.
9. Validate metadata shape, summary length, category membership, duplicate identities, path availability, and catalog consistency before reporting success.

Do not claim a sync succeeded when any write or validation step failed. Report affected Skills and leave recoverable backups before modifying installed metadata.

## Command Reference

Run commands from this Skill directory. Add `--json` to any command for machine-readable output.

```text
node scripts/manager.mjs scan [--project-root PATH] [--json]
node scripts/manager.mjs snapshot [--project-root PATH] [--json]
node scripts/manager.mjs changes [--json]
node scripts/manager.mjs apply --id ID --display-name NAME --short-description DESCRIPTION --category CATEGORY_ID [--confirmed] [--json]
node scripts/manager.mjs restore --id ID [--json]
node scripts/manager.mjs categories list [--json]
node scripts/manager.mjs categories add --id ID --name NAME [--json]
node scripts/manager.mjs categories rename --id CURRENT_ID --new-id NEW_ID --name NAME [--json]
node scripts/manager.mjs validate [--json]
```

`snapshot` performs a fresh scan before recording identifiers and fingerprints. After installation, `scan` refreshes the catalog and `changes` reports the complete `new`, `changed`, and `unchanged` sets relative to that snapshot. English `original_name` and `original_description` always come from the downloaded `SKILL.md` and remain read-only.

## Classification Rules

Use only the categories in `data/categories.json`. Prefer the Skill's purpose over its installation source. Keep ambiguous items in `其他` and flag them for review rather than guessing.

Treat category, Chinese display name, and Chinese summary as user-editable. Treat English invocation name and original English description as read-only source fields in the UI.

## Open the UI

1. Refresh the catalog when the UI opens so it includes newly downloaded Skills. Opening the UI makes an explicit scan request; reading `/api/catalog` alone does not scan or write.
2. Run `node scripts/server.mjs`. The completed Skill bundles this local-only management server and selects an available loopback port.
3. Open the interface and show Chinese display name, Chinese summary, English invocation, original English description, category, source, availability, and pending-change status.
   The default view shows available Skills. “全部记录” includes removed Skills retained for history, while “已失效” isolates them.
4. Apply edits only through the same backup, write, index, and validation pipeline used by sync.

Do not expose the server on a public network interface. Do not silently apply generated translations or classifications when `data/settings.json` requires confirmation.
The local UI obtains a per-server session token before any write request. External clients must supply that token in the `x-skill-manager-token` header.

## Open the Desktop App

The manager includes an Electron desktop wrapper and can be packaged with `npm run dist`. The portable executable reads the manager installed at `~/.codex/skills/skill-library-manager`, starts the loopback service internally, and closes it when the app exits. Users do not need to open or remember a localhost URL. The UI includes a pending center for localization, repair, and unavailable-Skill queues.

## Settings Contract

Use `data/settings.json` as the persisted source of truth for approval behavior. Its defaults auto-apply localized metadata to personal and user Skills, while plugin, system, project, and unknown sources require confirmation. External installs remain discoverable on the next sync or UI open and then follow the same source policy. Preserve user edits to these settings during sync.

## Catalog Contract

Use `data/catalog.json` as the canonical managed index and `data/settings.json` as the canonical approval policy. Every Skill entry must retain:

- stable identifier, source type, discovery path, and availability;
- `original_name` and `original_description` copied verbatim from downloaded frontmatter;
- Chinese `display_name` and `short_description` as separate managed fields;
- category, fingerprint, timestamps, and review state.

An empty catalog is valid before the first scan. Never seed invented Skill records.

## Common Mistakes

- Renaming the Skill folder or English frontmatter to match the Chinese display name.
- Replacing the original English description with its translation.
- Losing unrelated `openai.yaml` fields during a metadata update.
- Treating plugin version paths as stable identities.
- Reporting installation complete before enrollment, indexing, and validation finish.
