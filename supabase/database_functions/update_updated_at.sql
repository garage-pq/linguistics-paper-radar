
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
