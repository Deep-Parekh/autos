import { z } from 'zod';

/**
 * Per-project JDK and Tomcat toolchains.
 *
 * The Confluence branch map may name a JDK major version and a Tomcat version per project (optional `JDK` and
 * `Tomcat` columns). A blank cell falls back to the repository build profile (`build_profiles.<id>.jdk|tomcat`).
 * Versions are names only: the trusted runner resolves them inside its toolchain root
 * (`AUTOS_TOOLCHAIN_ROOT`, default `~/.autos/toolchains`), never as paths taken from Confluence:
 *
 *   <root>/jdk/<major>/          a Linux JDK home for the container architecture (bin/java, release)
 *   <root>/tomcat/<version>/     a sanitized Tomcat home (bin, lib incl. JDBC drivers, conf without credentials)
 *
 * The selected directories are mounted read-only into agent and check containers at TOOLCHAIN_MOUNTS, with
 * JAVA_HOME/CATALINA_HOME set and $JAVA_HOME/bin first on PATH. Toolchains never contain credentials.
 */
export const jdkVersionSchema = z.string().regex(/^(?:1[7-9]|[2-9][0-9])$/, 'JDK must be a major version such as 21');
export const tomcatVersionSchema = z.string().regex(/^(?:[7-9]|1[0-9])\.[0-9]{1,2}\.[0-9]{1,3}$/, 'Tomcat must be a full version such as 11.0.24');
export const toolchainSelectionSchema = z.strictObject({ jdk: jdkVersionSchema, tomcat: tomcatVersionSchema.nullable() });
export type ToolchainSelection = z.infer<typeof toolchainSelectionSchema>;

/** Installed, validated toolchain names reported by supervisor health (no paths). */
export const installedToolchainsSchema = z.strictObject({ jdk: z.array(jdkVersionSchema), tomcat: z.array(tomcatVersionSchema) });
export type InstalledToolchains = z.infer<typeof installedToolchainsSchema>;

/**
 * Container paths. `scratch` is a disk-backed, per-container writable directory (deleted afterwards) where roles
 * copy the source to build, so build output never lands in the workspace. CATALINA_BASE is prepared inside it by
 * the worker entrypoint from CATALINA_HOME/conf. `mavenLocal` is the writable Maven repository layered over the
 * read-only offline cache (`-Dmaven.repo.local.tail`).
 */
export const TOOLCHAIN_MOUNTS = {
  jdk: '/opt/toolchains/jdk', tomcat: '/opt/toolchains/tomcat', scratch: '/scratch',
  catalinaBase: '/scratch/catalina-base', mavenLocal: '/scratch/m2', mavenCache: '/opt/autos/m2/repository',
} as const;

/**
 * Branch-map cell parsers. Return null for a blank cell, undefined for an unrecognized value.
 * JDK accepts `21`, `JDK 21`, `jdk21`, `Java 21`, `Corretto 21`, `Amazon Corretto 21`, `21.0.9` (major is kept).
 * Tomcat accepts `11.0.24`, `Tomcat 11.0.24`, `apache-tomcat-11.0.24`.
 */
export function parseJdkCell(cell: string): string | null | undefined {
  const text = cell.trim();
  if (!text) return null;
  const match = /^(?:(?:amazon[\s-]*)?corretto[\s-]*|jdk[\s-]*|java[\s-]*)?([0-9]{2})(?:\.[0-9]+){0,3}$/i.exec(text);
  if (!match) return undefined;
  return jdkVersionSchema.safeParse(match[1]).success ? match[1] : undefined;
}
export function parseTomcatCell(cell: string): string | null | undefined {
  const text = cell.trim();
  if (!text) return null;
  const match = /^(?:apache[\s-]*)?(?:tomcat[\s-]*)?([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,3})$/i.exec(text);
  if (!match) return undefined;
  return tomcatVersionSchema.safeParse(match[1]).success ? match[1] : undefined;
}

export type ToolchainResolution = { ok: true; toolchain: ToolchainSelection | null } | { ok: false; reason: string };
/**
 * Branch-map values win over the build profile; each field falls back independently.
 * No JDK anywhere means no toolchain (the checks image's built-in JDK is used and agents have no Java).
 * A Tomcat without a JDK is a configuration error.
 */
export function resolveToolchain(mapping: { jdk?: string | null | undefined; tomcat?: string | null | undefined }, profile: { jdk?: string | undefined; tomcat?: string | undefined } | undefined): ToolchainResolution {
  const jdk = mapping.jdk ?? profile?.jdk ?? null;
  const tomcat = mapping.tomcat ?? profile?.tomcat ?? null;
  if (!jdk) return tomcat ? { ok: false, reason: 'A Tomcat version is set but no JDK is configured for this project' } : { ok: true, toolchain: null };
  const parsed = toolchainSelectionSchema.safeParse({ jdk, tomcat });
  return parsed.success ? { ok: true, toolchain: parsed.data } : { ok: false, reason: 'Configured JDK or Tomcat version is invalid' };
}

/** Names of toolchains in `selection` that `installed` lacks, e.g. ['JDK 25', 'Tomcat 11.0.24']. */
export function missingToolchains(selection: ToolchainSelection, installed: InstalledToolchains): string[] {
  const missing: string[] = [];
  if (!installed.jdk.includes(selection.jdk)) missing.push(`JDK ${selection.jdk}`);
  if (selection.tomcat && !installed.tomcat.includes(selection.tomcat)) missing.push(`Tomcat ${selection.tomcat}`);
  return missing;
}
