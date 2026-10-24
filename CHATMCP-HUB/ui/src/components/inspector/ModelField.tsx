import { Component, Suspense, lazy, type ReactNode } from 'react';
import type { ModelFieldProps } from './ModelPicker';

// The model picker (the list of models under the field, the line about the model typed in it, the Hub's list of models and its update) is a script of its own, fetched when this field first
// renders. Until it is there, and when it never comes (the page is older than the files the Hub serves now, or the connection dropped), the field is the plain input it always was:
// a person can type the model name whatever happens to the picker.
const ModelPicker = lazy(() => import('./ModelPicker').then((module) => ({ default: module.ModelPicker })));

/** Shows `fallback` instead of its children when the children fail to load: a picker that cannot be had must not take the page down. */
export class PickerBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function ModelField(props: ModelFieldProps) {
  const plain = (
    <input
      type="text"
      id={props.id}
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      className={props.inputClassName}
    />
  );
  return (
    <PickerBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <ModelPicker {...props} />
      </Suspense>
    </PickerBoundary>
  );
}
