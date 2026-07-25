export type Role = 'student' | 'teacher' | 'admin' | string;

export interface MeResponse {
  user: { id: string; username: string; display_name: string; avatar_url?: string | null };
  camp: { id: string; slug: string; name: string; kind: string };
  role: Role;
  project_id: string | null;
}

export interface Version {
  id: string;
  label: string;
  seq?: number;
  summary?: string | null;
  submitted_at?: string | null;
  preview_url?: string | null;
}

export interface DiagnosisItem {
  check_key?: string;
  label?: string;
  applicability?: 'applicable' | 'not_applicable' | string;
  earned_points?: number;
  max_points?: number;
  result?: 'pass' | 'fail' | 'unknown' | 'not_applicable' | string;
  evidence_level?: 'verified' | 'client_reported' | 'ai_inferred' | 'human_required' | string;
  evidence?: { declaration_status?: 'declared' | 'undeclared' | string };
  is_blocker?: boolean;
}

export interface Diagnosis {
  id: string;
  status?: string;
  stale?: boolean;
  score?: number | null;
  completeness?: number | null;
  verified_ratio?: number | null;
  applicable_earned?: number | null;
  applicable_max?: number | null;
  applicable_items?: number | null;
  verified_applicable_items?: number | null;
  blocked?: boolean;
  items: DiagnosisItem[];
  summary?: string | null;
  next_steps?: string[];
}

export interface ProjectSnapshot {
  project: {
    id: string;
    slug: string;
    title: string;
    tagline?: string | null;
    category?: string | null;
    dev_status?: string;
    publish_status?: string;
    live_url?: string | null;
    updated_at?: string | null;
  };
  owner: { id: string; username: string; display_name: string };
  camp: { id: string; slug: string; name: string; kind: string };
  live_version: Version | null;
  pending_version: Version | null;
  latest_diagnosis: Diagnosis | null;
  last_review: { status: string; comment?: string | null; decided_at?: string | null; version_id?: string } | null;
  stats: { total_views?: number | null; today_views?: number | null };
  timeline: Array<{ at?: string | null; kind?: string; title?: string; detail?: string }>;
}

export interface ReviewQueueItem {
  id: string;
  version_id: string;
  project_id: string;
  project_title: string;
  owner_name: string;
  owner_username?: string;
  avatar_url?: string | null;
  label: string;
  summary?: string | null;
  created_at?: string | null;
  status: string;
}

export interface ReviewsResponse {
  items: ReviewQueueItem[];
  counts: { pending?: number; published?: number };
}

export interface CampOverview {
  camp: { id: string; name: string; slug: string; kind: string };
  counts: {
    members: number; invites_bound: number; invites_total: number; projects: number;
    not_started: number; developing: number; needs_revision: number; pending_review: number; published: number;
  };
  stale: Array<{ id: string; title: string; owner: string; updated_at?: string | null }>;
  recent: Array<{ id: string; title: string; owner: string; dev_status?: string | null; publish_status?: string | null; updated_at?: string | null }>;
}

export interface CampProject {
  id: string; title: string; owner_name: string; owner_username?: string; updated_at?: string | null;
  dev_status?: string | null; publish_status?: string | null; pending_version_id?: string | null;
}

export interface InviteListItem {
  code_masked: string; status: 'unused' | 'bound' | 'revoked' | string; role: 'student' | 'teacher' | string;
  max_devices: number; devices: number; created_at?: string | null; bound_at?: string | null;
  bound_user?: string | null; bound_project?: string | null;
}

export interface ReviewDetail {
  review: { id: string; status: string; comment?: string | null; created_at?: string | null; decided_at?: string | null };
  version: Version;
  diagnosis: Diagnosis | null;
  project: ProjectSnapshot['project'];
  owner: ProjectSnapshot['owner'];
  live_version: Version | null;
}

export interface CampCollection {
  camp: { slug: string; name: string; kind?: string; theme?: string | null; intro?: string | null; cover_url?: string | null };
  stats: { published?: number; creators?: number; categories?: number };
  categories: string[];
  items: Array<{
    slug: string;
    title: string;
    tagline?: string | null;
    category?: string | null;
    cover_url?: string | null;
    author: string;
    avatar_url?: string | null;
    version?: string | null;
    views?: number | null;
    url?: string | null;
    updated_at?: string | null;
  }>;
  updated_at?: string | null;
}
