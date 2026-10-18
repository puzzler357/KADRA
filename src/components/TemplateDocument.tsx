import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Employee, Template } from '../data/types';
import { useAppStore } from '../store/useAppStore';
import { useMoney } from '../lib/money';
import { formatDate, localDateISO } from '../lib/dates';
import { canonicalName, renderTemplate } from '../lib/templateVars';
import type { TemplateValues } from '../lib/templateVars';
import { renderTable } from '../lib/templateBlocks';

/**
 * Значения переменных документа.
 *
 * auto — то, что заполняется само: карточка сотрудника, «Настройки → Общие»,
 * сегодняшняя дата. Введённое вручную важнее: человек правит поле именно
 * тогда, когда карточка его не устраивает.
 */
const NO_MANUAL: Record<string, string> = {};

export function useTemplateValues(employee?: Employee | null, manual: Record<string, string> = NO_MANUAL): { values: TemplateValues; auto: TemplateValues } {
  const money = useMoney();
  const { orgName, orgDirector, orgInn, dateFormat } = useAppStore();
  return useMemo(() => {
    const auto: TemplateValues = {
      orgName,
      today: formatDate(localDateISO(), dateFormat),
      ...(orgDirector ? { director: orgDirector } : {}),
      ...(orgInn ? { inn: orgInn } : {}),
      ...(employee ? {
        fullName: employee.fullName,
        position: employee.position,
        department: employee.department,
        salary: money.format(employee.salary ?? 0),
        hireDate: formatDate(employee.hireDate, dateFormat),
      } : {}),
    };
    const values: TemplateValues = { ...auto };
    for (const [name, value] of Object.entries(manual)) {
      if (value !== '') values[canonicalName(name)] = value;
    }
    return { values, auto };
  }, [employee, manual, money, orgName, orgDirector, orgInn, dateFormat]);
}

/**
 * Документ по шаблону: белый лист с чёрным текстом в любой теме.
 * Текст выводится React-узлами, а не HTML-строкой: ФИО из импорта с «<» и
 * прочими символами больше не может сломать разметку документа.
 */
export function TemplateDocument({ template, values, className = '' }: { template: Template; values: TemplateValues; className?: string }) {
  const { t } = useTranslation();
  return (
    <article className={`template-document bg-white text-black ${className}`}>
      <h1 className="text-2xl font-bold mb-8 text-center">{template.name}</h1>
      <div className="text-sm leading-relaxed">
        {template.blocks.map((block) => {
          if (block.type === 'signature') {
            return (
              <div key={block.id} className="flex justify-between gap-8 mt-16 mb-8">
                <div className="w-[30%] border-t border-black pt-2 text-center text-sm">{t('builder.employeeSignature')}</div>
                <div className="w-[30%] border-t border-black pt-2 text-center text-sm">
                  {t('builder.headSignature')}
                  {values.director && <div className="mt-1">{values.director}</div>}
                </div>
              </div>
            );
          }
          if (block.type === 'table') {
            const table = renderTable(block, values, t);
            return (
              <table key={block.id} className="w-full border-collapse mb-6">
                <thead>
                  <tr>
                    {table.columns.map((col, i) => (
                      <th key={i} className="border border-[#cbd5e1] bg-[#f1f5f9] px-3 py-2 text-left font-semibold">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => <td key={c} className="border border-[#cbd5e1] px-3 py-2 align-top whitespace-pre-wrap">{cell}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          }
          const text = renderTemplate(block.content || '', values);
          return text.trim() === '' ? null : <p key={block.id} className="mb-4 whitespace-pre-wrap">{text}</p>;
        })}
      </div>
    </article>
  );
}

/**
 * Область печати поверх приложения. Пока она смонтирована, при печати
 * выводится только она — без меню, кнопок и фона темы. Так печатают и
 * «Генерация документов», и «Документ» из списка сотрудников, и конструктор
 * шаблонов; раньше карточка сотрудника печатала через отдельное окно, которое
 * в настольной версии могло не открыться.
 */
export function PrintPortal({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add('has-print-portal');
    return () => document.body.classList.remove('has-print-portal');
  }, []);
  return createPortal(<div className="print-portal">{children}</div>, document.body);
}
