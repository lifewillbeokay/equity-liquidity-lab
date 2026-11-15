import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const curveCache=sqliteTable('curve_cache',{
 key:text('key').primaryKey(),issuer:text('issuer').notNull(),stock:text('stock').notNull(),
 objectKey:text('object_key'),capturedAt:text('captured_at'),expiresAt:integer('expires_at').notNull().default(0),
 storedAt:integer('stored_at').notNull().default(0),origin:text('origin'),
 leaseOwner:text('lease_owner'),leaseUntil:integer('lease_until').notNull().default(0),
 retryAt:integer('retry_at').notNull().default(0),lastError:text('last_error'),reference:text('reference').notNull(),
},t=>[index('curve_cache_stock').on(t.stock),index('curve_cache_expiry').on(t.expiresAt)]);
export const poolReads=sqliteTable('pool_reads',{
 key:text('key').primaryKey(),chain:text('chain').notNull(),blockHash:text('block_hash').notNull(),
 value:text('value').notNull(),expiresAt:integer('expires_at').notNull(),
},t=>[index('pool_reads_expiry').on(t.expiresAt)]);
export const references=sqliteTable('market_references',{
 stock:text('stock').primaryKey(),value:text('value').notNull(),expiresAt:integer('expires_at').notNull(),
});
