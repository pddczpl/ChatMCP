import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { 
  Puzzle, 
  Search, 
  Check, 
  Download, 
  Trash2, 
  ShieldCheck, 
  Sparkles, 
  ExternalLink 
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

interface Skill {
  id: string;
  name: string;
  description: string;
  author: string;
  category: 'code' | 'test' | 'security' | 'devops' | 'general';
  installed: boolean;
  official?: boolean;
}

export function SkillsTab() {
  const { showToast } = useAppStore();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');

  const { data: hub, refetch } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 5000 });

  const [skills, setSkills] = useState<Skill[]>([
    {
      id: 'git-sentinel',
      name: 'Git Sentinel',
      description: 'Tự động kiểm tra branch, staged changes và tạo commit message chuẩn Conventional Commits.',
      author: 'ChatMCP Core',
      category: 'devops',
      installed: true,
      official: true,
    },
    {
      id: 'ast-refactor',
      name: 'AST Code Refactor',
      description: 'Phân tích Abstract Syntax Tree TypeScript/Python và thực hiện refactor cấu trúc sạch.',
      author: 'ChatMCP Core',
      category: 'code',
      installed: true,
      official: true,
    },
    {
      id: 'jest-playwright-generator',
      name: 'Auto Test Generator',
      description: 'Sinh test tự động với Playwright và Vitest/Jest kèm mock data và kiểm tra coverage.',
      author: 'Community',
      category: 'test',
      installed: false,
      official: false,
    },
    {
      id: 'sec-audit-guard',
      name: 'Security Audit Guard',
      description: 'Rà soát lỗ hổng bảo mật OWASP, kiểm tra token rò rỉ, phân tích dependency CVE và CSP.',
      author: 'ChatMCP Core',
      category: 'security',
      installed: false,
      official: true,
    },
    {
      id: 'docker-compose-helper',
      name: 'Container DevOps Hub',
      description: 'Tạo và tối ưu Dockerfile multi-stage, docker-compose.yml và pipeline GitHub Actions.',
      author: 'Community',
      category: 'devops',
      installed: false,
      official: false,
    },
  ]);

  const categories = [
    { id: 'all', label: 'Tất cả' },
    { id: 'code', label: 'Lập trình' },
    { id: 'test', label: 'Kiểm thử' },
    { id: 'security', label: 'Bảo mật' },
    { id: 'devops', label: 'DevOps' },
  ];

  const filteredSkills = skills.filter((s) => {
    const matchCat = activeCategory === 'all' || s.category === activeCategory;
    const matchSearch = `${s.name} ${s.description}`.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const handleToggleInstall = (id: string) => {
    setSkills((prev) =>
      prev.map((s) => {
        if (s.id === id) {
          const next = !s.installed;
          showToast(next ? `Đã cài đặt skill ${s.name}` : `Đã gỡ cài đặt skill ${s.name}`, 'info');
          return { ...s, installed: next };
        }
        return s;
      })
    );
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-3 select-none text-xs perspective-container">
      {/* Header and Search */}
      <div className="space-y-2 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Puzzle className="w-4 h-4 text-sky-400" />
            <span className="font-semibold text-xs text-[var(--text)]">Chợ kỹ năng (Skills Marketplace)</span>
          </div>
          <span className="text-[10px] text-[var(--faint)]">Mở rộng sức mạnh agent</span>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm kiếm skill..."
            className="w-full bg-[var(--surface)] text-[var(--text)] text-xs rounded-md pl-8 pr-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
          />
        </div>

        {/* Categories Bar */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors ${
                activeCategory === c.id
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                  : 'bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--surface-hover)] border border-transparent'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Skills Grid with 3D Tilt */}
      <div className="space-y-2.5 transform-style-3d">
        {filteredSkills.map((s) => (
          <Card
            key={s.id}
            tilt3d
            className="p-3 bg-[var(--panel)] border-[var(--line)] hover:border-sky-500/40 transition-all flex flex-col justify-between gap-2.5"
          >
            <div>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-xs text-[var(--text)]">
                    {s.name}
                  </span>
                  {s.official && (
                    <span className="px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider bg-teal-500/20 text-teal-300 border border-teal-500/30 flex items-center gap-1">
                      <ShieldCheck className="w-2.5 h-2.5" />
                      Official
                    </span>
                  )}
                </div>

                <span className="text-[10px] text-[var(--faint)]">
                  bởi {s.author}
                </span>
              </div>

              <p className="text-[11px] text-[var(--muted)] mt-1 line-clamp-2 leading-relaxed">
                {s.description}
              </p>
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-[var(--line-subtle)]">
              <span className="text-[10px] font-mono text-[var(--faint)] uppercase">
                #{s.category}
              </span>

              {s.installed ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
                    <Check className="w-3 h-3" />
                    Đã cài
                  </span>
                  <button
                    onClick={() => handleToggleInstall(s.id)}
                    className="p-1 rounded text-[var(--faint)] hover:text-rose-400 hover:bg-rose-950/30 transition-colors"
                    title="Gỡ bỏ skill"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => handleToggleInstall(s.id)}
                  className="h-6 text-[11px] px-2 gap-1"
                >
                  <Download className="w-3 h-3" />
                  <span>Cài đặt</span>
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
