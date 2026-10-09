// Keep old shared links working; the client composer lives in the map workspace.
location.replace(`/${location.search}${location.hash || "#tab=composer"}`);
