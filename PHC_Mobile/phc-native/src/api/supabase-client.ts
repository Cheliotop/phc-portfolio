import supabase from '../lib/supabase';
import type { PostgrestQueryBuilder } from '@supabase/supabase-js';
import type { Database } from '../types/supabase.generated';

type PublicTable = keyof Database['public']['Tables'];
type PublicSchema = Database['public'];
type GeneratedTable<Table extends PublicTable> = PublicSchema['Tables'][Table];
type GeneratedRow<Table extends PublicTable> = GeneratedTable<Table> extends {
  Row: infer Row extends Record<string, unknown>;
} ? Row : never;
type GeneratedInsert<Table extends PublicTable> = GeneratedTable<Table> extends { Insert: unknown }
  ? GeneratedTable<Table>['Insert']
  : never;
type GeneratedUpdate<Table extends PublicTable> = GeneratedTable<Table> extends { Update: unknown }
  ? GeneratedTable<Table>['Update']
  : never;
type TableRow<Table extends PublicTable> = GeneratedRow<Table>;
type TableInsert<Table extends PublicTable> = GeneratedInsert<Table>;
type TableUpdate<Table extends PublicTable> = GeneratedUpdate<Table>;
type TableColumn<Table extends PublicTable> = Extract<keyof TableRow<Table>, string>;
type NoExtraKeys<Shape, Candidate extends Shape> = Candidate & Record<
  Exclude<keyof Candidate, keyof Shape>,
  never
>;
type TableWithId = {
  [Table in PublicTable]: 'id' extends keyof TableRow<Table> ? Table : never;
}[PublicTable];
type TableId<Table extends TableWithId> = TableRow<Table> extends { id: infer Id }
  ? Id
  : never;

interface ListOptions<Table extends PublicTable> {
  orderBy?: TableColumn<Table>;
  orderDir?: 'asc' | 'desc';
  filters?: Partial<TableRow<Table>>;
}

type TableQuery<Table extends PublicTable> = PostgrestQueryBuilder<
  { PostgrestVersion: '12' },
  PublicSchema,
  GeneratedTable<Table>,
  Table
>;

// supabase-js loses the table/row correlation when a relation name is generic.
// This bridge restates that exact generated-schema relationship; it does not
// widen the relation or payload and keeps every public wrapper call keyed by
// its concrete table name.
const tableQuery = <Table extends PublicTable>(table: Table): TableQuery<Table> => {
  return supabase.from(table) as TableQuery<Table>;
};

const applyFilters = <Table extends PublicTable, Query>(
  query: Query,
  filters: Partial<TableRow<Table>> | undefined,
  apply: (current: Query, key: TableColumn<Table>, value: TableRow<Table>[TableColumn<Table>]) => Query,
): Query => {
  if (!filters) return query;
  let filtered = query;
  for (const key in filters) {
    const value = filters[key];
    if (value !== undefined && value !== null) {
      filtered = apply(filtered, key, value);
    }
  }
  return filtered;
};

export const db = {
  from: <Table extends PublicTable>(table: Table) => tableQuery(table),

  async getAll<Table extends PublicTable>(
    table: Table,
    options?: ListOptions<Table>,
  ): Promise<TableRow<Table>[]> {
    let query = tableQuery(table).select('*');
    query = applyFilters(query, options?.filters, (current, key, value) => current.filter(key, 'eq', value));
    if (options?.orderBy) {
      query = query.order(options.orderBy, {
        ascending: (options.orderDir || 'desc') === 'asc',
      });
    }
    const { data, error } = await query.overrideTypes<TableRow<Table>[], { merge: false }>();
    if (error) throw error;
    return data || [];
  },

  async getById<Table extends TableWithId>(
    table: Table,
    id: TableId<Table>,
  ): Promise<TableRow<Table> | null> {
    const { data, error } = await tableQuery(table)
      .select('*')
      .filter('id', 'eq', id)
      .maybeSingle()
      .overrideTypes<TableRow<Table> | null, { merge: false }>();
    if (error) throw error;
    return data as TableRow<Table> | null;
  },

  async create<Table extends PublicTable, Insert extends TableInsert<Table>>(
    table: Table,
    data: NoExtraKeys<TableInsert<Table>, Insert>,
  ): Promise<TableRow<Table>> {
    const { data: result, error } = await tableQuery(table)
      .insert<Insert>(data)
      .select()
      .single()
      .overrideTypes<TableRow<Table>, { merge: false }>();
    if (error) throw error;
    return result as TableRow<Table>;
  },

  async update<Table extends TableWithId, Update extends TableUpdate<Table>>(
    table: Table,
    id: TableId<Table>,
    data: NoExtraKeys<TableUpdate<Table>, Update>,
  ): Promise<TableRow<Table>> {
    const response = await tableQuery(table)
      .update<Update>(data)
      .filter('id', 'eq', id)
      .select()
      .single()
      .overrideTypes<TableRow<Table>, { merge: false }>();
    if (response.error) throw response.error;
    return response.data as TableRow<Table>;
  },

  async delete<Table extends TableWithId>(table: Table, id: TableId<Table>): Promise<void> {
    const { error } = await tableQuery(table).delete().filter('id', 'eq', id);
    if (error) throw error;
  },

  async getPaginated<Table extends PublicTable>(
    table: Table,
    page: number = 1,
    pageSize: number = 20,
    options?: ListOptions<Table>,
  ): Promise<{
    data: TableRow<Table>[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasMore: boolean;
  }> {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let countQuery = tableQuery(table).select('*', { count: 'exact', head: true });
    let dataQuery = tableQuery(table).select('*').range(from, to);

    countQuery = applyFilters(countQuery, options?.filters, (current, key, value) => current.filter(key, 'eq', value));
    dataQuery = applyFilters(dataQuery, options?.filters, (current, key, value) => current.filter(key, 'eq', value));
    if (options?.orderBy) {
      dataQuery = dataQuery.order(options.orderBy, {
        ascending: (options.orderDir || 'desc') === 'asc',
      });
    }

    const { count, error: countError } = await countQuery;
    if (countError) throw countError;

    const { data, error } = await dataQuery.overrideTypes<TableRow<Table>[], { merge: false }>();
    if (error) throw error;

    const total = count || 0;
    const totalPages = Math.ceil(total / pageSize);

    return {
      data: data || [],
      total,
      page,
      pageSize,
      totalPages,
      hasMore: page < totalPages,
    };
  },
};
