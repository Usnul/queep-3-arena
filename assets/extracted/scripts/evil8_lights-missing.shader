textures/evil8_lights/e8tinylight
{
	qer_editorimage textures/evil8_lights/e8tinylight.tga
	// q3map_lightimage textures/evil8_lights/e8tinylight.blend.tga
	surfaceparm nomarks
	q3map_surfacelight 950
	{
		map textures/evil8_lights/e8tinylight.tga
	}
	{
		map $lightmap 
		blendfunc filter
		tcGen lightmap 
	}
	// {
	// 	map textures/evil8_lights/e8tinylight.blend.tga
	// 	blendfunc add
	// }
}

