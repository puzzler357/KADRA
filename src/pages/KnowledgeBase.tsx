import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Book, FileText, ChevronRight, Hash, Bookmark, ArrowLeft, Save, Bold, Italic, Strikethrough, Heading1, Heading2, List, ListOrdered, Pencil, Trash2 } from 'lucide-react';
import { useEditor, useEditorState, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { useDatabaseStore, TABLES } from '../store/useDatabaseStore';
import type { KbArticle } from '../store/useDatabaseStore';
import { clickable } from '../lib/a11y';
import { localDateISO, useDates } from '../lib/dates';
import { useNotify } from '../components/Toasts';
import { primaryButton, secondaryButton } from '../components/Modal';

const toolbarButton = (active: boolean) =>
  `p-2 rounded-lg transition-colors ${active ? 'bg-surface-4 text-primary' : 'text-muted hover:bg-surface-hover hover:text-primary'}`;

const MenuBar = ({ editor }: { editor: Editor }) => {
  const { t } = useTranslation();
  // Состояние кнопок читается подпиской: без неё подсветка «Полужирный» и
  // т. п. не менялась бы при перемещении курсора.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      green: e.isActive('textStyle', { color: '#047857' }),
      red: e.isActive('textStyle', { color: '#be123c' }),
    }),
  });

  return (
    <div className="flex flex-wrap gap-1 p-2 bg-surface border-b border-line rounded-t-xl items-center" role="toolbar" aria-label={t('kb.content')}>
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={toolbarButton(state.bold)} title={t('kb.toolbar.bold')} aria-label={t('kb.toolbar.bold')} aria-pressed={state.bold}>
        <Bold className="w-4 h-4" />
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={toolbarButton(state.italic)} title={t('kb.toolbar.italic')} aria-label={t('kb.toolbar.italic')} aria-pressed={state.italic}>
        <Italic className="w-4 h-4" />
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleStrike().run()} className={toolbarButton(state.strike)} title={t('kb.toolbar.strike')} aria-label={t('kb.toolbar.strike')} aria-pressed={state.strike}>
        <Strikethrough className="w-4 h-4" />
      </button>

      <div className="w-px h-6 bg-surface-4 mx-1" />

      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={toolbarButton(state.h1)} title={t('kb.toolbar.h1')} aria-label={t('kb.toolbar.h1')} aria-pressed={state.h1}>
        <Heading1 className="w-4 h-4" />
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={toolbarButton(state.h2)} title={t('kb.toolbar.h2')} aria-label={t('kb.toolbar.h2')} aria-pressed={state.h2}>
        <Heading2 className="w-4 h-4" />
      </button>

      <div className="w-px h-6 bg-surface-4 mx-1" />

      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={toolbarButton(state.bullet)} title={t('kb.toolbar.bulletList')} aria-label={t('kb.toolbar.bulletList')} aria-pressed={state.bullet}>
        <List className="w-4 h-4" />
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={toolbarButton(state.ordered)} title={t('kb.toolbar.orderedList')} aria-label={t('kb.toolbar.orderedList')} aria-pressed={state.ordered}>
        <ListOrdered className="w-4 h-4" />
      </button>

      <div className="w-px h-6 bg-surface-4 mx-1" />

      {/* Цвета подобраны так, чтобы текст читался и на светлом, и на тёмном фоне. */}
      <button type="button" onClick={() => editor.chain().focus().setColor('#047857').run()} className={toolbarButton(state.green)} title={t('kb.toolbar.greenText')} aria-label={t('kb.toolbar.greenText')} aria-pressed={state.green}>
        <span className="block w-4 h-4 rounded-full bg-emerald-700" />
      </button>
      <button type="button" onClick={() => editor.chain().focus().setColor('#be123c').run()} className={toolbarButton(state.red)} title={t('kb.toolbar.redText')} aria-label={t('kb.toolbar.redText')} aria-pressed={state.red}>
        <span className="block w-4 h-4 rounded-full bg-rose-700" />
      </button>
      <button type="button" onClick={() => editor.chain().focus().unsetColor().run()} className={toolbarButton(false)} title={t('kb.toolbar.plainText')} aria-label={t('kb.toolbar.plainText')}>
        <span className="block w-4 h-4 rounded-full border-2 border-current" />
      </button>
    </div>
  );
};

// Категории в базе хранят только имя и порядок; иконка — оформление,
// поэтому берётся по кругу из фиксированного набора.
const CATEGORY_ICONS = [Book, FileText, Hash, Bookmark];

/** Пустой ли HTML редактора: «<p></p>» — это тоже пусто. */
const isBlankHtml = (html: string) => html.replace(/<[^>]*>/g, '').trim() === '';

export default function KnowledgeBase() {
  const { t } = useTranslation();
  const notify = useNotify();
  const dates = useDates();
  const { kbCategories, kbArticles, createIn, updateIn, removeFrom } = useDatabaseStore();

  // null — список; 'new' — новая статья; id — правка существующей.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [articleTitle, setArticleTitle] = useState('');
  const [articleCategory, setArticleCategory] = useState('');
  const [titleError, setTitleError] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [viewingArticleId, setViewingArticleId] = useState<string | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyle,
      Color,
      // Подсказка — именно подсказка: исчезает при вводе и не попадает в
      // статью. Раньше она была настоящим текстом редактора и сохранялась.
      Placeholder.configure({ placeholder: t('kb.editorPlaceholder') }),
    ],
    content: '',
    onUpdate: () => setDirty(true),
    editorProps: {
      attributes: {
        class: 'kb-content focus:outline-none min-h-[400px] max-w-none p-6 text-primary',
        'aria-label': t('kb.content'),
      },
    },
  });

  // Категория по умолчанию выводится из справочника, а не проставляется
  // эффектом: лишний проход рендера здесь ни к чему.
  const currentCategory = articleCategory || kbCategories[0]?.id || '';
  // Разделы первого запуска (kc1–kc3) — общая рубрикация, а не данные
  // пользователя: показываются на языке интерфейса, пока их не переименовали.
  const SEED_CATEGORY_NAMES: Record<string, string> = { kc1: 'Кадровые процедуры', kc2: 'Документы и справки', kc3: 'Onboarding' };
  const labelOf = (cat: { id: string; name: string }) =>
    SEED_CATEGORY_NAMES[cat.id] === cat.name ? t(`kb.seedCategories.${cat.id}`) : cat.name;
  const categoryName = (id?: string) => {
    const cat = kbCategories.find(c => c.id === id);
    return cat ? labelOf(cat) : t('kb.general');
  };

  // Счётчик статей считается по данным — раньше рядом с каждой категорией
  // стояло фиксированное число (12/8/5/24), ни на что не реагировавшее.
  const articleCount = (categoryId: string) => kbArticles.filter(a => a.categoryId === categoryId).length;

  const viewingArticle = viewingArticleId ? kbArticles.find(a => a.id === viewingArticleId) ?? null : null;

  const startWriting = (article?: KbArticle) => {
    setEditingId(article ? article.id : 'new');
    setArticleTitle(article?.title ?? '');
    setArticleCategory(article?.categoryId ?? '');
    setTitleError(false);
    editor?.commands.setContent(article?.contentHtml ?? '', { emitUpdate: false });
    setDirty(false);
  };

  const leaveEditor = async () => {
    if (dirty && !(await notify.confirm(t('kb.discardConfirm')))) return;
    setEditingId(null);
    setDirty(false);
  };

  const handleSave = async () => {
    const title = articleTitle.trim();
    if (!title) { setTitleError(true); return; }
    const html = editor?.getHTML() ?? '';
    const contentHtml = isBlankHtml(html) ? '' : html;
    const today = localDateISO();
    try {
      if (editingId && editingId !== 'new') {
        await updateIn(TABLES.kbArticles, editingId, { title, categoryId: currentCategory || null, contentHtml, updatedAt: today });
        setViewingArticleId(editingId);
      } else {
        await createIn<KbArticle>(TABLES.kbArticles, {
          categoryId: currentCategory || undefined,
          title,
          contentHtml,
          reads: 0,
          createdAt: today,
          updatedAt: today,
        });
      }
      notify.success(t('kb.saved'));
      setEditingId(null);
      setDirty(false);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteArticle = async (article: KbArticle) => {
    if (!(await notify.confirm(t('kb.deleteConfirm', { title: article.title }), { danger: true }))) return;
    await removeFrom(TABLES.kbArticles, article.id);
    setViewingArticleId(null);
    notify.success(t('kb.deleted'));
  };

  const openArticle = (id: string, reads: number) => {
    setViewingArticleId(id);
    // Счётчик прочтений — реальное поле в базе, а не декорация.
    void updateIn(TABLES.kbArticles, id, { reads: reads + 1 });
  };

  if (editingId) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-4">
            <button
              onClick={leaveEditor}
              aria-label={t('common.back')}
              className="p-2 bg-surface border border-line hover:bg-surface-hover rounded-xl transition-colors text-muted"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-primary">{editingId === 'new' ? t('kb.newArticle') : t('kb.editArticle')}</h2>
              <p className="text-muted mt-1">{t('kb.newArticleSub')}</p>
            </div>
          </div>
          <button onClick={handleSave} className={`${primaryButton} flex items-center gap-2`}>
            <Save className="w-4 h-4" />
            {t('common.save')}
          </button>
        </div>

        <div className="bg-surface border border-line rounded-2xl p-6 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div className="sm:col-span-2">
              <label htmlFor="kb-title" className="block text-sm font-medium text-muted mb-2">{t('kb.articleTitle')} *</label>
              <input
                id="kb-title"
                type="text"
                value={articleTitle}
                onChange={e => { setArticleTitle(e.target.value); setTitleError(false); setDirty(true); }}
                placeholder={t('kb.titlePh')}
                aria-invalid={titleError}
                className="w-full bg-app border border-line rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 transition-colors aria-[invalid=true]:border-rose-500"
              />
              {titleError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 mt-1">{t('kb.titleRequired')}</p>}
            </div>
            <div>
              <label htmlFor="kb-category" className="block text-sm font-medium text-muted mb-2">{t('kb.category')}</label>
              <select
                id="kb-category"
                value={currentCategory}
                onChange={e => { setArticleCategory(e.target.value); setDirty(true); }}
                className="w-full bg-app border border-line rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 transition-colors"
              >
                {kbCategories.map(cat => (
                  <option key={cat.id} value={cat.id}>{labelOf(cat)}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <p className="block text-sm font-medium text-muted mb-2">{t('kb.content')}</p>
            <div className="bg-app border border-line rounded-xl overflow-hidden flex flex-col">
              {editor && <MenuBar editor={editor} />}
              <EditorContent editor={editor} className="flex-1" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const query = searchQuery.trim().toLowerCase();
  const filteredArticles = kbArticles.filter(article => {
    const text = (article.contentHtml ?? '').replace(/<[^>]*>/g, ' ');
    const matchesSearch = !query || `${article.title} ${text}`.toLowerCase().includes(query);
    const matchesCategory = selectedCategoryId ? article.categoryId === selectedCategoryId : true;
    return matchesSearch && matchesCategory;
  }).sort((a, b) => (query || selectedCategoryId ? a.title.localeCompare(b.title, 'ru') : b.reads - a.reads));

  if (viewingArticle) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setViewingArticleId(null)}
              aria-label={t('common.back')}
              className="p-2 bg-surface border border-line hover:bg-surface-hover rounded-xl transition-colors text-muted"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h2 className="text-2xl font-bold tracking-tight text-primary">{viewingArticle.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => startWriting(viewingArticle)} className={`${secondaryButton} flex items-center gap-2`}>
              <Pencil className="w-4 h-4" /> {t('common.edit')}
            </button>
            <button onClick={() => deleteArticle(viewingArticle)} className="border border-rose-500/30 text-rose-700 dark:text-rose-400 hover:bg-rose-500/10 px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2">
              <Trash2 className="w-4 h-4" /> {t('common.delete')}
            </button>
          </div>
        </div>
        <div className="bg-surface border border-line rounded-2xl p-8">
          <div className="flex flex-wrap items-center gap-2 mb-6">
            <span className="text-xs text-accent-700 dark:text-accent-300 bg-accent-500/10 px-2 py-1 rounded-md">{categoryName(viewingArticle.categoryId)}</span>
            <span className="text-xs text-muted">{t('kb.reads', { count: viewingArticle.reads })}</span>
            <span className="text-xs text-muted">· {t('kb.updated', { date: dates.date(viewingArticle.updatedAt) })}</span>
          </div>
          {viewingArticle.contentHtml
            ? <div className="kb-content text-primary" dangerouslySetInnerHTML={{ __html: viewingArticle.contentHtml }} />
            : <p className="text-muted">{t('kb.emptyArticle')}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-primary">{t('kb.title')}</h2>
          <p className="text-muted mt-1">{t('kb.subtitle')}</p>
        </div>
        <button onClick={() => startWriting()} className={primaryButton}>
          {t('kb.writeArticle')}
        </button>
      </div>

      <div className="relative max-w-2xl mx-auto my-8">
        <Search className="w-6 h-6 absolute left-4 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('kb.searchPh')}
          aria-label={t('common.search')}
          className="w-full bg-surface border-2 border-line rounded-2xl pl-14 pr-4 py-4 text-base focus:outline-none focus:border-accent-500 focus:ring-1 focus:ring-accent-500 transition-colors shadow-lg shadow-black/5"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {kbCategories.map((cat, index) => {
          const Icon = CATEGORY_ICONS[index % CATEGORY_ICONS.length];
          const isSelected = selectedCategoryId === cat.id;
          return (
            <div
              key={cat.id}
              {...clickable(() => setSelectedCategoryId(isSelected ? null : cat.id), labelOf(cat))}
              aria-pressed={isSelected}
              className={`${isSelected ? 'bg-surface-3 border-accent-500' : 'bg-surface border-line'} border hover:border-strong rounded-2xl p-6 cursor-pointer transition-colors group`}
            >
              <div className="w-12 h-12 bg-surface-3 text-accent-700 dark:text-accent-300 rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Icon className="w-6 h-6" />
              </div>
              <h3 className="font-semibold text-primary mb-1">{labelOf(cat)}</h3>
              <p className="text-sm text-muted">{t('kb.articlesCount', { count: articleCount(cat.id) })}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-8">
        <h3 className="text-xl font-semibold text-primary mb-4">{query || selectedCategoryId ? t('kb.searchResults') : t('kb.popular')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredArticles.map(article => (
            <div key={article.id} {...clickable(() => openArticle(article.id, article.reads), article.title)} className="bg-surface-2 border border-line hover:bg-surface-hover rounded-xl p-4 flex items-center justify-between cursor-pointer transition-colors">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-surface-3 rounded-lg flex items-center justify-center text-muted">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-medium text-primary">{article.title}</h4>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-accent-700 dark:text-accent-300 bg-accent-500/10 px-2 py-0.5 rounded">{categoryName(article.categoryId)}</span>
                    <span className="text-xs text-muted">• {t('kb.reads', { count: article.reads })}</span>
                  </div>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-muted" />
            </div>
          ))}

          {filteredArticles.length === 0 && (
            <div className="p-8 text-center text-muted border border-dashed border-line rounded-xl md:col-span-2">
              {query || selectedCategoryId ? t('kb.nothingFound') : t('kb.noArticles')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
