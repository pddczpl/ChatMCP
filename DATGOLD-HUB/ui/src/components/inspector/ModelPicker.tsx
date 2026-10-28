import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { hasTranslation, useTranslation, type Translate, type TranslationKey } from '@/lib/i18n';
import '@/lib/i18n-models'; // the strings only the picker asks for load with it
import { accountOutcome, badgesOf, factsOf, filterChoices, keyAction, mergeChoices, type Badge as BadgeData } from '@/lib/model-picker';
import { useModelInfo } from '@/lib/useModelInfo';
import { Badge } from '@/components/ui/Badge';
import type { AccountModel } from '@/types';
import { CatalogStatusLine } from './CatalogStatus';

export interface ModelFieldProps {
  id: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** The classes of the input, which the picker keeps: it is the field that was there. */
  inputClassName: string;
  /** The connection preset (anthropic, openai, custom-openai ...) when there is one; a model profile has none. */
  preset?: string;
  protocol?: string;
  apiBaseUrl: string;
  /**
   * true: the form is the connection the Hub holds, so the Hub can ask the provider (with the saved key) which models the account can use; false: it is not saved yet, say so;
   * nothing (a model profile): the Hub's connection is not the profile's, so there is no such button.
   */
  canListAccount?: boolean;
  /** Show the line that names the Hub's list of models and updates it (the AI connection shows it once; a model profile does not). */
  showCatalog?: boolean;
  /** How many times the form was saved: what the provider answered about the account's models is for one of them (a new key for the same address is another account). */
  accountRevision?: number;
}

/** At most this many models are drawn: the list of one provider can hold 600. */
const SHOWN = 50;

function badgeText(t: Translate, badge: BadgeData): string {
  if (badge.kind === 'context') return t(badge.params?.input ? 'ai_model_badge_context_limited' : 'ai_model_badge_context', badge.params);
  if (badge.kind === 'price') return t('ai_model_badge_price', badge.params);
  if (badge.kind === 'status') {
    const key = `ai_model_status_${badge.params?.status}`;
    return hasTranslation(key) ? t(key as TranslationKey) : String(badge.params?.status);
  }
  return t(`ai_model_badge_${badge.kind}` as TranslationKey);
}

function Chips({ badges }: { badges: BadgeData[] }) {
  const { t } = useTranslation();
  return (
    <>
      {badges.map((badge, index) => (
        <Fragment key={badge.kind}>
          {index > 0 ? ' ' : null}
          <Badge>{badgeText(t, badge)}</Badge>
        </Fragment>
      ))}
    </>
  );
}

/**
 * The model field of the AI settings: the input that was there (any model name can still be typed), a button that opens the list of the models of this provider with what the Hub knows of
 * each (context window, price, thinking, tools, images), and a line under the field about the model typed in it. The list is the Hub's own (a file read) until the owner asks for the account's
 * (the provider is asked with the saved key). It is a script of its own: ModelField shows the plain input until it is here.
 */
export function ModelPicker(props: ModelFieldProps) {
  const { t } = useTranslation();
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // The text in the field filters the list only after it was typed in: opening the list on a model that is already chosen shows all of them, not that one.
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(0);
  // What the provider answered about the account's models, and for which connection it was asked.
  const [account, setAccount] = useState<{ for?: string; models?: AccountModel[]; message?: string; busy?: boolean }>({});

  const apiBaseUrl = props.apiBaseUrl.trim();
  const hasTarget = Boolean(props.preset || apiBaseUrl);
  // What was asked of the provider belongs to the connection it was asked for (the preset, the address and how many times the form was saved: a new key for the same address is another account):
  // another provider chosen in the form, another address or a save shows nothing of it, and an answer that comes after that is kept for the connection it was for.
  const connection = `${props.preset ?? ''}|${apiBaseUrl}|${props.accountRevision ?? 0}`;
  const mine: typeof account = account.for === connection ? account : {};
  const list = useQuery({
    queryKey: ['catalogModels', props.preset ?? '', apiBaseUrl],
    queryFn: () => api.getCatalogModels({ preset: props.preset, apiBaseUrl }),
    enabled: open && hasTarget,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const { data: info } = useModelInfo({ preset: props.preset, protocol: props.protocol, apiBaseUrl: props.apiBaseUrl, model: props.value });
  // A model the catalog marks deprecated is not offered, except the one in the field: a connection that uses it still shows it.
  const choices = useMemo(() => mergeChoices(list.data?.models, mine.models, { keep: [props.value] }), [list.data, mine.models, props.value]);
  const { shown, total } = filterChoices(choices, typed ? props.value : '', SHOWN);
  // A list that typing opened is drawn only when it has something to offer: a person typing a name the catalog does not have (a new model, an Ollama tag, a private deployment) is not shown a
  // box that says there is no list. The browse button and the arrow keys open it whatever it holds, and then it says why when it is empty.
  const visible = open && (!typed || shown.length > 0);
  // The place that is active, never past the end of the list (it shrinks when the account's models replace the catalog's or a filter narrows it); -1 is none: typing leaves none.
  const activeAt = Math.min(active, shown.length - 1);
  const facts = factsOf(info);

  useEffect(() => {
    if (visible) document.getElementById(`${listId}-${activeAt}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [visible, activeAt, listId]);
  // Opened near the foot of the scrolling body of a dialog (the first-run one) the box would be cut off by it: when it opens, and when the models arrive and make it taller, it is scrolled into view, as far as that takes.
  useEffect(() => {
    if (visible) boxRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [visible, shown.length]);

  const pick = (id: string) => {
    props.onChange(id);
    setOpen(false);
    setTyped(false);
  };
  const toggle = () => {
    // A press on the button does not take the focus (the list would close before the press is a click), so the field is given it: the arrows, Enter and Escape then act on the list the button opened.
    inputRef.current?.focus();
    setOpen(!visible);
    setTyped(false);
    setActive(0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // A key that belongs to an input method (a word still being composed, as with Vietnamese Telex; Safari sends the Enter that ends it with key code 229) is not for the list.
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
    const action = keyAction(event.key, visible, activeAt, shown.length);
    if (action.type === 'none') return;
    event.preventDefault();
    if (action.type === 'open') { setOpen(true); setTyped(false); setActive(0); }
    else if (action.type === 'move') setActive(action.active);
    else if (action.type === 'pick') pick(shown[action.index].id);
    else setOpen(false);
  };
  const loadAccount = async () => {
    if (mine.busy) return;
    const asked = connection;
    setAccount((current) => ({ ...(current.for === asked ? current : {}), for: asked, busy: true }));
    try {
      const outcome = accountOutcome(await api.getModels(), t);
      setAccount(outcome.ok ? { for: asked, models: outcome.models, message: outcome.message } : { for: asked, message: outcome.message });
    } catch (error) {
      setAccount({ for: asked, message: `${t('ai_model_account_failed')} ${error instanceof Error ? error.message : ''}`.trim() });
    }
  };

  let note: string;
  // Nothing to show: either the list is on its way (the query has no answer yet, and there is something to ask about), or the Hub has none for this connection (a private server, one on this
  // machine, a provider it does not know, a failed request).
  if (choices.length === 0) note = hasTarget && list.isPending ? t('ai_model_loading') : t('ai_model_no_catalog');
  else {
    // The Hub caps what it sends of a provider's list and says how many there are: that count, not what came, is the size of the list. The account's own list is whole, and so is what a filter leaves.
    const all = typed || mine.models ? total : Math.max(total, list.data?.total ?? 0);
    note = [mine.models ? mine.message : list.data ? t('ai_model_source', { source: list.data.source }) : '', all > shown.length ? t('ai_model_count', { shown: shown.length, total: all }) : '']
      .filter(Boolean).join(' · ');
  }

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            id={props.id}
            role="combobox"
            aria-label={props.ariaLabel}
            aria-autocomplete="list"
            aria-expanded={visible}
            aria-controls={visible ? listId : undefined}
            aria-activedescendant={visible && shown[activeAt] ? `${listId}-${activeAt}` : undefined}
            value={props.value}
            placeholder={props.placeholder}
            onChange={(event) => { props.onChange(event.target.value); setTyped(true); setOpen(true); setActive(-1); }}
            onKeyDown={onKeyDown}
            onBlur={() => setOpen(false)}
            className={`${props.inputClassName} min-w-0 flex-1`}
          />
          <button
            type="button"
            aria-label={t('ai_model_browse')}
            title={t('ai_model_browse')}
            aria-haspopup="listbox"
            aria-expanded={visible}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggle}
            className="shrink-0 rounded-md border border-line p-1.5 text-muted hover:bg-hover"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        {visible && (
          <div ref={boxRef} className="absolute z-20 mt-1 w-full rounded-md border border-line bg-panel shadow-lg" onMouseDown={(event) => event.preventDefault()}>
            <ul id={listId} role="listbox" aria-label={t('ai_model_list_label')} className="max-h-64 overflow-y-auto py-1">
              {shown.map((choice, index) => (
                <li
                  key={choice.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={choice.id === props.value}
                  onClick={() => pick(choice.id)}
                  onMouseEnter={() => setActive(index)}
                  className={`flex cursor-pointer flex-wrap items-center gap-x-1.5 gap-y-1 px-2.5 py-1.5 text-xs ${index === activeAt ? 'bg-hover' : ''} ${choice.id === props.value ? 'text-primary' : 'text-fg'}`}
                >
                  <span className="font-mono">{choice.id}</span>{' '}
                  <Chips badges={badgesOf(choice)} />
                </li>
              ))}
            </ul>
            <p data-testid="model-list-note" className="border-t border-line-subtle px-2.5 py-1.5 text-[12px] text-faint">{note}</p>
            {props.canListAccount === true && (
              <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle px-2.5 py-1.5 text-[12px]">
                <button type="button" disabled={mine.busy} title={t('ai_model_load_account_hint')} onClick={() => void loadAccount()} className="rounded-md border border-line px-2 py-1 text-fg hover:bg-hover disabled:opacity-50">
                  {t('ai_model_load_account')}
                </button>
                {mine.message && !mine.models && <span role="status" className="text-warning">{mine.message}</span>}
              </div>
            )}
            {props.canListAccount === false && <p className="border-t border-line-subtle px-2.5 py-1.5 text-[12px] text-faint">{t('ai_model_account_save_first')}</p>}
          </div>
        )}
      </div>
      {facts && (
        <p data-testid="model-facts" className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] ${facts.kind === 'alias' ? 'text-warning' : 'text-faint'}`}>
          {facts.kind === 'known'
            ? <><span>{t('ai_model_facts_known', { source: facts.source })}</span>{' '}<Chips badges={facts.badges} /></>
            : <span>{t('ai_model_facts_alias', { id: facts.id, source: facts.source })}</span>}
        </p>
      )}
      {props.showCatalog && <CatalogStatusLine />}
    </div>
  );
}
