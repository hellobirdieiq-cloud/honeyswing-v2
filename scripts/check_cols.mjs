import { createClient } from '@supabase/supabase-js';
const s = createClient(
  'https://xutbbirehugrrbkauhnl.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dGJiaXJlaHVncnJia2F1aG5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0Njg5NTAsImV4cCI6MjA4ODA0NDk1MH0.OjNH1MR3rJcxMNLcIewgMZxU_iBJOGRfxewEu8LlxMU'
);
const { data, error } = await s.from('swings').select('*').limit(1);
if (error) console.log('error:', error.message);
else if (!data || !data.length) console.log('no rows - RLS blocking anon');
else console.log('columns:', Object.keys(data[0]));
