import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://xutbbirehugrrbkauhnl.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dGJiaXJlaHVncnJia2F1aG5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0Njg5NTAsImV4cCI6MjA4ODA0NDk1MH0.OjNH1MR3rJcxMNLcIewgMZxU_iBJOGRfxewEu8LlxMU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
