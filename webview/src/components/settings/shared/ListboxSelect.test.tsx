import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ListboxSelect from './ListboxSelect';

const OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
];

const renderSelect = (overrides: Record<string, unknown> = {}) => {
  const onChange = vi.fn();
  const utils = render(
    <ListboxSelect
      value="en"
      options={OPTIONS}
      onChange={onChange}
      ariaLabel="Language"
      {...overrides}
    />,
  );
  const trigger = screen.getByRole('combobox', { name: 'Language' });
  return { onChange, trigger, ...utils };
};

const getOptions = () => screen.getAllByRole('option');

describe('ListboxSelect keyboard interaction', () => {
  it('closes and refocuses the trigger when Escape is pressed with focus on an option', () => {
    const { trigger } = renderSelect();
    fireEvent.click(trigger);
    getOptions()[1].focus();

    fireEvent.keyDown(getOptions()[1], { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger after picking an option', () => {
    const { onChange, trigger } = renderSelect();
    fireEvent.click(trigger);

    fireEvent.click(getOptions()[1]);

    expect(onChange).toHaveBeenCalledWith('zh');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens the menu on ArrowDown and focuses the selected option', () => {
    const { trigger } = renderSelect({ value: 'zh' });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    const selected = getOptions().find((el) => el.getAttribute('aria-selected') === 'true');
    expect(selected).toBeDefined();
    expect(document.activeElement).toBe(selected);
  });

  it('moves focus with ArrowDown/ArrowUp including wrap-around', () => {
    const { trigger } = renderSelect();
    fireEvent.click(trigger);

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(getOptions()[0]);

    fireEvent.keyDown(getOptions()[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(getOptions()[1]);

    fireEvent.keyDown(getOptions()[1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(getOptions()[0]);

    fireEvent.keyDown(getOptions()[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(getOptions()[2]);

    fireEvent.keyDown(getOptions()[2], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(getOptions()[0]);
  });

  it('jumps to first/last option with Home/End', () => {
    const { trigger } = renderSelect();
    fireEvent.click(trigger);
    getOptions()[0].focus();

    fireEvent.keyDown(getOptions()[0], { key: 'End' });
    expect(document.activeElement).toBe(getOptions()[2]);

    fireEvent.keyDown(getOptions()[2], { key: 'Home' });
    expect(document.activeElement).toBe(getOptions()[0]);
  });

  it('focuses the matching option on typeahead', () => {
    const { trigger } = renderSelect();
    fireEvent.click(trigger);

    fireEvent.keyDown(trigger, { key: '中' });

    expect(document.activeElement).toBe(getOptions()[1]);
  });

  it('closes the menu when focus leaves the component', () => {
    const { trigger } = renderSelect();
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.blur(trigger, { relatedTarget: document.body });

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps the menu open when focus moves between trigger and options', () => {
    const { trigger } = renderSelect();
    fireEvent.click(trigger);

    fireEvent.blur(trigger, { relatedTarget: getOptions()[0] });

    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('does not open on ArrowDown when disabled', () => {
    const { trigger } = renderSelect({ disabled: true });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
