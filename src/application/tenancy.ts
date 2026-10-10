import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { config } from '../config.js';
import { projects, tenantMembers, tenants, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from './password.js';

export const DEFAULT_TENANT_SLUG = 'local';

export async function bootstrapTenancy(): Promise<{ tenantId: number; userId: number }> {
  let tenant = (await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1))[0];
  if (!tenant) {
    const created = await db.insert(tenants).values({ name: 'Local', slug: DEFAULT_TENANT_SLUG });
    tenant = (await db.select().from(tenants).where(eq(tenants.id, created[0].insertId)))[0]!;
  }
  await db.update(projects).set({ tenantId: tenant.id }).where(isNull(projects.tenantId));

  const email = config.bootstrapEmail;
  let user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!user) {
    const created = await db.insert(users).values({
      email,
      name: 'Local Admin',
      passwordHash: await hashPassword(config.bootstrapPassword),
    });
    user = (await db.select().from(users).where(eq(users.id, created[0].insertId)))[0]!;
  }
  const membership = (await db.select().from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenant.id), eq(tenantMembers.userId, user.id)))
    .limit(1))[0];
  if (!membership) {
    await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: 'owner' });
  }
  return { tenantId: tenant.id, userId: user.id };
}

export async function defaultTenantId(): Promise<number> {
  const tenant = (await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1))[0];
  if (!tenant) throw new Error('Default tenant is missing');
  return tenant.id;
}

export async function authenticateUser(email: string, password: string) {
  const user = (await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1))[0];
  if (!user || !(await verifyPassword(password, user.passwordHash))) return undefined;
  const memberships = await db.select({
    tenantId: tenantMembers.tenantId,
    role: tenantMembers.role,
    name: tenants.name,
    slug: tenants.slug,
  }).from(tenantMembers).innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(eq(tenantMembers.userId, user.id));
  return { user, memberships };
}

export async function registerUser(input: { email: string; password: string; name: string; tenantName?: string }) {
  const email = input.email.trim().toLowerCase();
  const existing = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0];
  if (existing) throw new Error('Email is already registered');
  const createdUser = await db.insert(users).values({
    email,
    name: input.name.trim() || email,
    passwordHash: await hashPassword(input.password),
  });
  const userId = createdUser[0].insertId;
  let tenantId: number;
  let role: 'owner' | 'admin' | 'member' = 'member';
  if (input.tenantName?.trim()) {
    const slug = input.tenantName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || `t-${userId}`;
    const createdTenant = await db.insert(tenants).values({ name: input.tenantName.trim(), slug });
    tenantId = createdTenant[0].insertId;
    role = 'owner';
  } else {
    tenantId = await defaultTenantId();
  }
  await db.insert(tenantMembers).values({ tenantId, userId, role });
  return { userId, tenantId, role };
}

export async function membershipsForUser(userId: number) {
  return db.select({
    tenantId: tenantMembers.tenantId,
    role: tenantMembers.role,
    name: tenants.name,
    slug: tenants.slug,
    status: tenants.status,
  }).from(tenantMembers).innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(eq(tenantMembers.userId, userId));
}

export async function assertProjectInTenant(projectId: number, tenantId: number): Promise<void> {
  const row = (await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)))
    .limit(1))[0];
  if (!row) throw new Error('Project is not in the current tenant');
}
