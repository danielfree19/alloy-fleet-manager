/**
 * Provider registry.
 *
 * Single source of truth for "which IdPs are configured right now" and
 * "what role(s) does this group claim map to". Merges:
 *
 *   1. YAML defaults (loaded once via SSO_CONFIG_FILE).
 *   2. DB overlay rows in `identity_providers` (created/edited from
 *      the UI; these win by id).
 *
 * Behavior:
 *
 *   - Build the YAML side, then for every YAML provider seed a
 *     `source='yaml'` row in `identity_providers` if not present.
 *     This lets the UI list YAML-managed providers without inventing
 *     a parallel persistence scheme. Operators who edit a YAML row
 *     in the UI flip its `source` to `ui` and the row from then on
 *     SHADOWS the YAML defaults.
 *
 *   - Role mappings are stored separately in
 *     `identity_provider_role_mappings`. YAML role mappings reference
 *     roles by NAME (since DB ids aren't stable across deployments);
 *     we resolve them to ids at build time. UI-managed mappings store
 *     ids directly.
 *
 *   - `rebuild()` re-runs build and replaces the in-memory map. Called
 *     from every admin mutation route after COMMIT.
 *
 * This module is a small piece of state on top of the DB. We chose a
 * mutable singleton over a per-request lookup because the providers
 * page + every login round trip would otherwise be a multi-query
 * round-trip even when nothing changed.
 */
import type { DbPool } from "../../db/pool.js";
import type { SsoProvider } from "./types.js";
import { OidcProvider, type OidcProviderConfig } from "./oidc.js";
import type { SsoYamlConfig, SsoYamlProvider } from "./config.js";

/**
 * Effective, fully-resolved provider config — a merge of YAML +
 * `identity_providers` row, with role mappings already resolved to
 * `role_id`s. Lives in memory; never persisted in this shape.
 */
export interface EffectiveProviderConfig {
  id: string;
  kind: "oidc" | "saml";
  display_name: string;
  source: "yaml" | "ui";

  // OIDC fields. (When/if SAML lands these become optional and a
  // matching `saml_*` block appears.)
  issuer: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes: string[];
  groups_claim: string;

  /** group_value → set of role ids. */
  role_mappings: Map<string, Set<string>>;
}

interface IdentityProviderRow {
  id: string;
  kind: string;
  display_name: string;
  issuer: string | null;
  client_id: string | null;
  client_secret: string | null;
  redirect_uri: string | null;
  scopes: string[] | null;
  groups_claim: string;
  source: "yaml" | "ui";
}

interface MappingRow {
  provider_id: string;
  group_value: string;
  role_id: string;
}

interface RoleNameToId {
  [name: string]: string;
}

export class ProviderRegistry {
  private byId: Map<string, SsoProvider> = new Map();
  private effectiveById: Map<string, EffectiveProviderConfig> = new Map();

  constructor(
    private readonly db: DbPool,
    private yaml: SsoYamlConfig | null,
  ) {}

  /**
   * Build (or rebuild) the in-memory registry from YAML + DB.
   * Idempotent. Safe to call concurrently — we mutate the maps at the
   * end so an in-flight read sees a consistent snapshot.
   */
  async rebuild(): Promise<void> {
    // 1. Seed DB rows for any YAML provider that doesn't have one yet.
    //    `source='yaml'` marks it so the UI knows it came from the
    //    file; an admin edit later will flip the row to source='ui'.
    if (this.yaml) {
      for (const p of this.yaml.providers) {
        await this.upsertYamlSeed(p);
      }
    }

    // 2. Read every DB row + every mapping row.
    const rows = await this.db.query<IdentityProviderRow>(
      `SELECT id, kind, display_name, issuer, client_id, client_secret,
              redirect_uri, scopes, groups_claim, source
         FROM identity_providers`,
    );
    const mappingRows = await this.db.query<MappingRow>(
      `SELECT provider_id, group_value, role_id
         FROM identity_provider_role_mappings`,
    );

    // 3. Group mappings by provider for O(1) lookup below.
    const mappingsByProvider = new Map<string, Map<string, Set<string>>>();
    for (const m of mappingRows.rows) {
      let bucket = mappingsByProvider.get(m.provider_id);
      if (!bucket) {
        bucket = new Map();
        mappingsByProvider.set(m.provider_id, bucket);
      }
      let set = bucket.get(m.group_value);
      if (!set) {
        set = new Set();
        bucket.set(m.group_value, set);
      }
      set.add(m.role_id);
    }

    // 4. Build effective configs. The DB row IS the merged view —
    //    the YAML seed already populated it on first boot. Subsequent
    //    YAML changes do flow through if the row is still source='yaml'
    //    (see upsertYamlSeed below — it overwrites yaml-source rows
    //    every boot so the YAML is "live" until an admin edits it).
    const nextEffective = new Map<string, EffectiveProviderConfig>();
    const nextProviders = new Map<string, SsoProvider>();

    for (const row of rows.rows) {
      if (row.kind !== "oidc") continue;
      if (
        !row.issuer ||
        !row.client_id ||
        !row.client_secret ||
        !row.redirect_uri
      ) {
        // A partial UI-managed row — surface in listProviders for
        // editing, but skip building an actual SsoProvider since
        // sign-in would 500. The admin-list view reads from the DB
        // directly, not from `byId`.
        continue;
      }
      const eff: EffectiveProviderConfig = {
        id: row.id,
        kind: "oidc",
        display_name: row.display_name,
        source: row.source,
        issuer: row.issuer,
        client_id: row.client_id,
        client_secret: row.client_secret,
        redirect_uri: row.redirect_uri,
        scopes: row.scopes ?? ["openid", "email", "profile"],
        groups_claim: row.groups_claim,
        role_mappings: mappingsByProvider.get(row.id) ?? new Map(),
      };
      nextEffective.set(eff.id, eff);
      nextProviders.set(eff.id, this.makeProvider(eff));
    }

    this.byId = nextProviders;
    this.effectiveById = nextEffective;
  }

  /**
   * On first boot (or after a YAML edit) ensure every YAML provider
   * has a backing DB row. We RESET the row to YAML values when its
   * source is still 'yaml' — that lets operators edit the YAML and
   * see the changes after a restart. Once an admin edits via the UI
   * the row's source flips to 'ui' and YAML changes for that id are
   * ignored (the plan documents this as the override semantic).
   */
  private async upsertYamlSeed(p: SsoYamlProvider): Promise<void> {
    const roleIdsByGroup = await this.resolveYamlRoleMappings(p);
    // Fast path: row already exists and is ui-managed → leave it alone.
    const existing = await this.db.query<{ source: "yaml" | "ui" }>(
      `SELECT source FROM identity_providers WHERE id = $1`,
      [p.id],
    );
    const existingRow = existing.rows[0];
    if (existingRow && existingRow.source === "ui") {
      return;
    }

    if (existingRow) {
      await this.db.query(
        `UPDATE identity_providers
            SET kind = $2,
                display_name = $3,
                issuer = $4,
                client_id = $5,
                client_secret = $6,
                redirect_uri = $7,
                scopes = $8,
                groups_claim = $9,
                source = 'yaml',
                updated_at = now()
          WHERE id = $1`,
        [
          p.id,
          p.kind,
          p.display_name,
          p.issuer,
          p.client_id,
          p.client_secret,
          p.redirect_uri,
          p.scopes,
          p.groups_claim,
        ],
      );
    } else {
      await this.db.query(
        `INSERT INTO identity_providers (
           id, kind, display_name, issuer, client_id, client_secret,
           redirect_uri, scopes, groups_claim, source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'yaml')`,
        [
          p.id,
          p.kind,
          p.display_name,
          p.issuer,
          p.client_id,
          p.client_secret,
          p.redirect_uri,
          p.scopes,
          p.groups_claim,
        ],
      );
    }

    // Replace yaml-source mappings every boot so `role_mappings`
    // edits in the YAML actually take effect.
    await this.db.query(
      `DELETE FROM identity_provider_role_mappings WHERE provider_id = $1`,
      [p.id],
    );
    for (const [group, roleIds] of roleIdsByGroup) {
      for (const roleId of roleIds) {
        await this.db.query(
          `INSERT INTO identity_provider_role_mappings
             (provider_id, group_value, role_id)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
          [p.id, group, roleId],
        );
      }
    }
  }

  private async resolveYamlRoleMappings(
    p: SsoYamlProvider,
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (Object.keys(p.role_mappings).length === 0) return out;
    const lookup = await this.loadRoleNameLookup();
    for (const [group, roleName] of Object.entries(p.role_mappings)) {
      const id = lookup[roleName];
      if (!id) {
        // Skip unknown roles silently — operators can fix the YAML
        // and restart. Logging here would require threading the
        // logger through; we'll surface it in the UI as "no roles
        // mapped for /fleet-admins" via the listMappings endpoint.
        continue;
      }
      let set = out.get(group);
      if (!set) {
        set = new Set();
        out.set(group, set);
      }
      set.add(id);
    }
    return out;
  }

  private async loadRoleNameLookup(): Promise<RoleNameToId> {
    const r = await this.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM roles`,
    );
    const out: RoleNameToId = {};
    for (const row of r.rows) out[row.name] = row.id;
    return out;
  }

  private makeProvider(cfg: EffectiveProviderConfig): SsoProvider {
    return new OidcProvider({
      id: cfg.id,
      display_name: cfg.display_name,
      source: cfg.source,
      issuer: cfg.issuer,
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      redirect_uri: cfg.redirect_uri,
      scopes: cfg.scopes,
      groups_claim: cfg.groups_claim,
    } satisfies OidcProviderConfig);
  }

  // -----------------------------------------------------------------
  // Read API used by routes
  // -----------------------------------------------------------------

  getProvider(id: string): SsoProvider | undefined {
    return this.byId.get(id);
  }

  /** Effective config (post-merge) — includes role mappings. */
  getEffective(id: string): EffectiveProviderConfig | undefined {
    return this.effectiveById.get(id);
  }

  /** Public list — used to build the login page buttons. */
  listProviders(): { id: string; display_name: string; kind: "oidc" | "saml" }[] {
    return Array.from(this.byId.values()).map((p) => ({
      id: p.id,
      display_name: p.displayName,
      kind: p.kind,
    }));
  }

  /** Resolve a list of group claim values into a deduped role_id list. */
  rolesForGroups(providerId: string, groups: string[]): string[] {
    const eff = this.effectiveById.get(providerId);
    if (!eff) return [];
    const out = new Set<string>();
    for (const g of groups) {
      const ids = eff.role_mappings.get(g);
      if (ids) for (const id of ids) out.add(id);
    }
    return Array.from(out);
  }

  /** Update the YAML side (used by tests; production callers always go through ctor + rebuild). */
  setYaml(yaml: SsoYamlConfig | null): void {
    this.yaml = yaml;
  }
}

/**
 * Convenience: build a registry from scratch given the same inputs the
 * server has at boot. The returned registry is already populated.
 */
export async function buildProviderRegistry(
  db: DbPool,
  yaml: SsoYamlConfig | null,
): Promise<ProviderRegistry> {
  const reg = new ProviderRegistry(db, yaml);
  await reg.rebuild();
  return reg;
}
