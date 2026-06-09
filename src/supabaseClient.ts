import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  'https://ygmhcyeedvyqyzhlsafu.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlnbWhjeWVlZHZ5cXl6aGxzYWZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3Njg2NzUsImV4cCI6MjA5NjM0NDY3NX0.-2ffmocVuXT5lr4IWNWljO4UGKUYD0CPmCbFsJJsrC8'
);