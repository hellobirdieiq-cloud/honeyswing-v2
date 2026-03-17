export const supabase = {
  auth: {
    async getSession() {
      return {
        data: {
          session: {
            user: { id: 'dev-user' }
          }
        }
      };
    }
  },
  from() {
    return {
      select() { return this; },
      eq() { return this; },
      gte() { return this; },
      async single() { return { data: null, error: null }; },
      async insert() { return { data: null, error: null }; }
    };
  }
};
