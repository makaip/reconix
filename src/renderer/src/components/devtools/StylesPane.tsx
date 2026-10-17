import { useState } from 'react'
import type { StyleRule } from '../../../../shared/devtools'

function matches(text: string, filter: string): boolean {
  return text.toLowerCase().includes(filter)
}

function StylesPane({ rules }: { rules: StyleRule[] | null }): JSX.Element {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()

  const visible = (rules ?? [])
    .map((rule) => {
      if (!needle) return rule
      const selectorHit = matches(rule.selector, needle)
      const properties = rule.properties.filter(
        (p) => selectorHit || matches(p.name, needle) || matches(p.value, needle)
      )
      return properties.length ? { ...rule, properties } : null
    })
    .filter((rule): rule is StyleRule => rule !== null)

  return (
    <div className="dt-styles">
      <div className="dt-styles__tabs" role="tablist">
        <button type="button" role="tab" aria-selected className="dt-tab dt-tab--active dt-tab--small">
          Styles
        </button>
      </div>

      <div className="dt-styles__filter">
        <input
          className="dt-styles__input"
          type="text"
          placeholder="Filter"
          aria-label="Filter styles"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="dt-styles__rules">
        {rules === null && <p className="dt-styles__empty">Select an element to see its styles.</p>}
        {visible.map((rule, index) => (
          <section key={`${rule.selector}:${index}`} className="dt-rule">
            <div className="dt-rule__head">
              <span className="dt-rule__selector">{`${rule.selector} {`}</span>
              {rule.origin === 'user-agent' && <span className="dt-rule__source">user agent stylesheet</span>}
              {rule.source && <span className="dt-rule__source dt-rule__source--link">{rule.source}</span>}
            </div>
            {rule.properties.map((property) => (
              <div key={property.name} className="dt-rule__property">
                <span className="dt-property">{property.name}</span>
                {`: ${property.value}${property.important ? ' !important' : ''};`}
              </div>
            ))}
            <div>{'}'}</div>
          </section>
        ))}
      </div>
    </div>
  )
}

export default StylesPane
