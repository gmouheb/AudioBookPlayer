export type PartStatus = 'queued' | 'generating' | 'ready' | 'error';

export interface PartInfo {
  index: number;
  status: PartStatus;
  duration: number | null;
  chars: number;
  error: string | null;
}

export interface ChapterInfo {
  index: number;
  title: string;
  status: PartStatus;
  parts: PartInfo[];
}

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  created: number;
  chapter_count: number;
  parts_total: number;
  parts_ready: number;
}

export interface BookDetail extends BookSummary {
  voice: string;
  chapters: ChapterInfo[];
}

export interface Health {
  status: string;
  model_ready: boolean;
}

export interface SavedPosition {
  chapter: number;
  part: number;
  time: number;
  updated: number;
}
