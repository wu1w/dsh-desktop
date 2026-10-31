class OwnAccessPolicyMixin:
    def _is_dm_intake_allowed(self, user_id, *args, **kwargs):
        return str(user_id) in self.config.extra.get('allow_from', []) or (not self.config.extra.get('allow_from') and self.config.extra.get('dsh_pairing', False))

    def _is_group_allowed(self, chat_id, user_id=None):
        allowed = self.config.extra.get('group_allow_from', [])
        return str(chat_id) in allowed and (user_id is None or self._is_dm_intake_allowed(user_id))
