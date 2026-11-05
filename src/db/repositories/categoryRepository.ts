import type { CategoryEntity, IDatabase } from '../types.ts';

export class CategoryRepository {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  async getAll(): Promise<CategoryEntity[]> {
    return this.db.getAllAsync<CategoryEntity>(
      'SELECT * FROM categories ORDER BY name ASC',
    );
  }

  async getById(id: string): Promise<CategoryEntity | null> {
    return this.db.getFirstAsync<CategoryEntity>(
      'SELECT * FROM categories WHERE id = ?',
      id,
    );
  }

  async findByName(name: string): Promise<CategoryEntity | null> {
    return this.db.getFirstAsync<CategoryEntity>(
      'SELECT * FROM categories WHERE LOWER(name) = LOWER(?)',
      name.trim(),
    );
  }

  async create(category: {
    id: string;
    user_id?: string | null;
    name: string;
    transaction_type: 'income' | 'expense' | 'both';
    icon?: string | null;
  }): Promise<CategoryEntity> {
    const now = new Date().toISOString();
    await this.db.runAsync(
      `INSERT INTO categories (id, user_id, name, transaction_type, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      category.id,
      category.user_id ?? null,
      category.name.trim(),
      category.transaction_type,
      category.icon ?? null,
      now,
      now,
    );

    return {
      id: category.id,
      user_id: category.user_id ?? null,
      name: category.name.trim(),
      transaction_type: category.transaction_type,
      icon: category.icon ?? null,
      created_at: now,
      updated_at: now,
    };
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.runAsync('DELETE FROM categories WHERE id = ?', id);
    return res.changes > 0;
  }

  async upsert(category: {
    id: string;
    user_id?: string | null;
    name: string;
    transaction_type: 'income' | 'expense' | 'both';
    icon?: string | null;
    color?: string | null;
  }): Promise<CategoryEntity> {
    const now = new Date().toISOString();
    await this.db.runAsync(
      `INSERT INTO categories (id, user_id, name, transaction_type, icon, color, is_custom, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         name = excluded.name,
         transaction_type = excluded.transaction_type,
         icon = excluded.icon,
         color = COALESCE(excluded.color, categories.color),
         is_custom = excluded.is_custom,
         updated_at = excluded.updated_at`,
      category.id,
      category.user_id ?? null,
      category.name.trim(),
      category.transaction_type,
      category.icon ?? null,
      category.color ?? null,
      category.user_id ? 1 : 0,
      now,
      now,
    );

    return {
      id: category.id,
      user_id: category.user_id ?? null,
      name: category.name.trim(),
      transaction_type: category.transaction_type,
      icon: category.icon ?? null,
      created_at: now,
      updated_at: now,
    };
  }
}
