'use client';

import { componentNames, componentSubsetViolations } from '@shizue/core/component';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { findComponentCalls } from '@/lib/componentCalls';
import type { PlatformContext } from '@/lib/componentRuntime';
import type { ComponentCapability } from '@/lib/types';
import { ComponentFrame } from './ComponentFrame';
import { Checkbox, ErrorText, Field, TextArea, TextInput } from './ui';

/** A call code to start from, so the preview has something to show. */
const SAMPLE_CALL = '<StatusWindow />';

/**
 * The component field and its preview.
 *
 * The preview is the same frame the chat mounts, driven by the same runtime and
 * the same bridge — a creator sees exactly what a reader will, including the
 * fallback card when the code does not compile. The platform state is the
 * plot's own defaults, so `platform.variables` reads the way it will in a real
 * chat — and `platform.char` is the work, exactly as it is in one.
 */
export function ComponentCodeEditor({
  code,
  capabilities,
  plotName,
  defaultVariables,
  onChange,
  onChangeCapabilities,
}: {
  code: string;
  /** What the components may ask a chat for; empty asks for nothing. */
  capabilities: ComponentCapability[];
  plotName: string;
  /** Seeds `platform.variables` in the preview, as they will seed a chat. */
  defaultVariables: Record<string, string>;
  onChange: (code: string) => void;
  onChangeCapabilities: (capabilities: ComponentCapability[]) => void;
}) {
  const t = useTranslations('plot');
  const chat = useTranslations('chat');
  const common = useTranslations('common');
  const [call, setCall] = useState(SAMPLE_CALL);

  const names = useMemo(() => componentNames(code), [code]);
  const violations = useMemo(() => componentSubsetViolations(code), [code]);
  const parsed = useMemo(() => findComponentCalls(call, names)[0], [call, names]);

  const platform = useMemo<PlatformContext>(
    () => ({
      variables: defaultVariables,
      relationship: null,
      turn: 1,
      char: plotName,
      user: t('componentPreviewUser'),
      assets: {},
    }),
    [defaultVariables, plotName, t],
  );

  return (
    <div className="space-y-4">
      <Field label={t('componentCode')} hint={t('componentCodeHint')}>
        <TextArea
          data-testid="component-code"
          rows={12}
          value={code}
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>

      <div data-testid="component-subset-error">
        <ErrorText>
          {violations.length > 0
            ? t('componentSubset', {
                rules: violations.map((code) => t(`subsetViolation.${code.split(':')[0]}`)).join(', '),
              })
            : ''}
        </ErrorText>
      </div>

      <p className="text-xs text-muted">
        {names.length > 0 ? t('componentDeclared', { names: names.join(', ') }) : t('componentNone')}
      </p>

      {/* Declaring it is only the first gate: the reader still grants it per chat. */}
      <div className="space-y-1">
        <Checkbox
          label={t('componentSendTurn')}
          checked={capabilities.includes('sendTurn')}
          onChange={(allowed) => onChangeCapabilities(allowed ? ['sendTurn'] : [])}
        />
        <p className="text-xs text-muted/80">{t('componentSendTurnHint')}</p>
      </div>

      <Field label={t('componentCall')} hint={t('componentCallHint')}>
        <TextInput
          data-testid="component-call"
          value={call}
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => setCall(event.target.value)}
        />
      </Field>

      <div data-testid="component-preview" className="rounded-lg border border-line bg-canvas/40 p-3">
        {parsed ? (
          <ComponentFrame
            code={code}
            name={parsed.name}
            props={parsed.props}
            platform={platform}
            errorLabel={chat('componentError')}
            navigatedLabel={chat('componentNavigated')}
            timeoutLabel={chat('componentTimeout')}
            retryLabel={common('retry')}
          />
        ) : (
          <p className="text-xs text-muted">{t('componentCallUnrecognized')}</p>
        )}
      </div>
    </div>
  );
}
