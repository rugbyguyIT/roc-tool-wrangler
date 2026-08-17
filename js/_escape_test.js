        reads the history in six months.</div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Who's fixing it?</label>
        <select class="form-input" name="shop_id">
          ${shops.map(s => `<option value="${s.id}"${s.id === defaultShopId ? ' selected' : ''}>${
            esc(s.name)}${s.is_internal ? '' : ' (outside)'}</option>`).join('')}
        </select>
        <div class="small muted">${defaultShopId
          ? 'Pre-set from this asset’s type — change it if someone else is doing the work.'
          : 'No default for this type. Set one under Admin → Lookups.'}</div></div>
      <div class="form-group"><label class="form-label">Expected back</label>
        <input class="form-input" type="datetime-local" name="expected_back" value="${dueLocal}" />
        <div class="small muted">Leave it if you don't know — it just drives the overdue flag.</div></div>
    </div>
    <div class="small muted">
