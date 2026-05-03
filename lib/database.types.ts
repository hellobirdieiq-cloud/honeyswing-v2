// SCR-0b-2: Supabase typegen output for public schema. Committed to repo (HC10).
// Regen: `supabase gen types typescript --linked > lib/database.types.ts`
// CLI version: 2.75.0 (pinned in package.json devDependencies).
// DO NOT edit by hand; regen after schema migrations.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      coaches: {
        Row: {
          auth_user_id: string | null
          code: string
          created_at: string | null
          email: string
          id: string
          name: string
          revenue_cap_cents: number | null
          revenue_share_pct: number | null
        }
        Insert: {
          auth_user_id?: string | null
          code: string
          created_at?: string | null
          email: string
          id?: string
          name: string
          revenue_cap_cents?: number | null
          revenue_share_pct?: number | null
        }
        Update: {
          auth_user_id?: string | null
          code?: string
          created_at?: string | null
          email?: string
          id?: string
          name?: string
          revenue_cap_cents?: number | null
          revenue_share_pct?: number | null
        }
        Relationships: []
      }
      events: {
        Row: {
          app_version: string | null
          emitted_at: string
          id: string
          idempotency_key: string
          payload: Json
          received_at: string
          session_id: string | null
          type: string
          user_id: string
        }
        Insert: {
          app_version?: string | null
          emitted_at: string
          id?: string
          idempotency_key: string
          payload: Json
          received_at?: string
          session_id?: string | null
          type: string
          user_id: string
        }
        Update: {
          app_version?: string | null
          emitted_at?: string
          id?: string
          idempotency_key?: string
          payload?: Json
          received_at?: string
          session_id?: string | null
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      grip_analyses: {
        Row: {
          analysis_failed: boolean | null
          confidence: string | null
          created_at: string
          handedness: string
          hands_match: string | null
          id: string
          lead_hand: string | null
          model_name: string
          overall: string | null
          prompt_version: string
          raw_response: Json | null
          reason: string | null
          storage_bucket: string | null
          storage_path: string | null
          trail_hand: string | null
          user_id: string
        }
        Insert: {
          analysis_failed?: boolean | null
          confidence?: string | null
          created_at?: string
          handedness: string
          hands_match?: string | null
          id?: string
          lead_hand?: string | null
          model_name: string
          overall?: string | null
          prompt_version?: string
          raw_response?: Json | null
          reason?: string | null
          storage_bucket?: string | null
          storage_path?: string | null
          trail_hand?: string | null
          user_id: string
        }
        Update: {
          analysis_failed?: boolean | null
          confidence?: string | null
          created_at?: string
          handedness?: string
          hands_match?: string | null
          id?: string
          lead_hand?: string | null
          model_name?: string
          overall?: string | null
          prompt_version?: string
          raw_response?: Json | null
          reason?: string | null
          storage_bucket?: string | null
          storage_path?: string | null
          trail_hand?: string | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          age: number | null
          anonymous_swing_count: number
          avatar_url: string | null
          coach_name: string | null
          created_at: string | null
          display_name: string | null
          id: string
          is_left_handed: boolean
          name: string | null
          referral_coach_id: string | null
        }
        Insert: {
          age?: number | null
          anonymous_swing_count?: number
          avatar_url?: string | null
          coach_name?: string | null
          created_at?: string | null
          display_name?: string | null
          id: string
          is_left_handed?: boolean
          name?: string | null
          referral_coach_id?: string | null
        }
        Update: {
          age?: number | null
          anonymous_swing_count?: number
          avatar_url?: string | null
          coach_name?: string | null
          created_at?: string | null
          display_name?: string | null
          id?: string
          is_left_handed?: boolean
          name?: string | null
          referral_coach_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_referral_coach_id_fkey"
            columns: ["referral_coach_id"]
            isOneToOne: false
            referencedRelation: "coaches"
            referencedColumns: ["id"]
          },
        ]
      }
      swings: {
        Row: {
          analysis_tier: string | null
          analysis_version: string
          angles: Json | null
          app_version: string | null
          backswing_ms: number | null
          capture_validity: string | null
          coach_name: string | null
          created_at: string | null
          downswing_ms: number | null
          duration_ms: number | null
          failure_reason: string | null
          feedback: Json | null
          frame_count: number | null
          honey_boom: boolean | null
          id: string
          impact_frame_index: number | null
          metric_confidences: Json | null
          motion_frames: Json | null
          phase_source: string | null
          phase_timestamps: Json | null
          phases: Json | null
          pose_success_rate: number | null
          score: number | null
          swing_debug: Json | null
          tempo: Json | null
          tempo_ratio: number | null
          trail_points: Json | null
          user_id: string | null
          video_storage_path: string | null
          video_uploaded_at: string | null
          video_url: string | null
        }
        Insert: {
          analysis_tier?: string | null
          analysis_version?: string
          angles?: Json | null
          app_version?: string | null
          backswing_ms?: number | null
          capture_validity?: string | null
          coach_name?: string | null
          created_at?: string | null
          downswing_ms?: number | null
          duration_ms?: number | null
          failure_reason?: string | null
          feedback?: Json | null
          frame_count?: number | null
          honey_boom?: boolean | null
          id?: string
          impact_frame_index?: number | null
          metric_confidences?: Json | null
          motion_frames?: Json | null
          phase_source?: string | null
          phase_timestamps?: Json | null
          phases?: Json | null
          pose_success_rate?: number | null
          score?: number | null
          swing_debug?: Json | null
          tempo?: Json | null
          tempo_ratio?: number | null
          trail_points?: Json | null
          user_id?: string | null
          video_storage_path?: string | null
          video_uploaded_at?: string | null
          video_url?: string | null
        }
        Update: {
          analysis_tier?: string | null
          analysis_version?: string
          angles?: Json | null
          app_version?: string | null
          backswing_ms?: number | null
          capture_validity?: string | null
          coach_name?: string | null
          created_at?: string | null
          downswing_ms?: number | null
          duration_ms?: number | null
          failure_reason?: string | null
          feedback?: Json | null
          frame_count?: number | null
          honey_boom?: boolean | null
          id?: string
          impact_frame_index?: number | null
          metric_confidences?: Json | null
          motion_frames?: Json | null
          phase_source?: string | null
          phase_timestamps?: Json | null
          phases?: Json | null
          pose_success_rate?: number | null
          score?: number | null
          swing_debug?: Json | null
          tempo?: Json | null
          tempo_ratio?: number | null
          trail_points?: Json | null
          user_id?: string | null
          video_storage_path?: string | null
          video_uploaded_at?: string | null
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "swings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_coach_by_code: {
        Args: { coach_code: string }
        Returns: {
          name: string
        }[]
      }
      merge_swing_debug: {
        Args: { patch: Json; swing_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
